import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';
import { RedisService } from '../redis/redis.service';
import { ChargerGateway } from '../charging/charging.gateway';
import { VerifySessionResponse, ChargerStatus } from '@packages/shared';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret = process.env.JWT_SECRET || 'super_secret_ephemeral_jwt_key_1234';
  private readonly guestAppUrl = process.env.GUEST_APP_URL;

  constructor(
    private readonly redis: RedisService,
    private readonly wsGateway: ChargerGateway
  ) {}

  /**
   * Called by the Physical Kiosk screen to render a QR code.
   * Generates a 2-minute ephemeral token.
   */
  async initiateQrSession(
    chargerId: string,
    connectorId: number,
    req: Request
  ): Promise<{ qrToken: string; qrUrl: string; expiresAt: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const hashedKey = createHash('sha256').update(rawToken).digest('hex');

    const expiresAt = new Date(Date.now() + 120 * 1000); // 2 minutes

    const payload = { chargerId, connectorId, createdAt: Date.now() };
    await this.redis.set(`qr:${hashedKey}`, JSON.stringify(payload), 'EX', 120);

    const qrUrl = this.buildGuestClaimUrl(req, rawToken);
    this.logger.log(`Session QR initiated for Charger ${chargerId}. Token: ${rawToken.slice(0, 8)}...`);

    return {
      qrToken: rawToken,
      qrUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Called by the Guest Mobile App.
   * Validates the rawToken and checks for session fixation/replay.
   */
  async verifyQrSession(rawToken: string, fingerprint: string): Promise<VerifySessionResponse> {
    const hashedKey = createHash('sha256').update(rawToken).digest('hex');
    const redisKey = `qr:${hashedKey}`;

    // 1. Fetch from Redis
    const dataRaw = await this.redis.get(redisKey);
    if (!dataRaw) {
      this.logger.warn(`Verification failed: QR token invalid or expired. Key: ${redisKey}`);
      throw new UnauthorizedException('QR Code is invalid or has expired.');
    }

    // 2. Consume immediately (Single-Use guarantee to prevent replay)
    await this.redis.del(redisKey);

    const { chargerId, connectorId } = JSON.parse(dataRaw);

    // 3. Coordinate state - notify the Physical Kiosk screen via WebSockets
    this.logger.log(`QR Token verified. Notifying Kiosk screen of Charger ${chargerId}.`);
    this.wsGateway.notifyKioskSessionClaimed(chargerId, connectorId);

    // 4. Generate JWT with the device signature embedded in the payload
    const hashedFingerprint = createHash('sha256').update(fingerprint).digest('hex');
    const accessToken = jwt.sign(
      {
        chargerId,
        connectorId,
        claimSignature: hashedFingerprint,
      },
      this.jwtSecret,
      { expiresIn: '1h' }
    );

    return {
      accessToken,
      chargerId,
      connectorId,
      status: 'Preparing', // Transition state
    };
  }

  /**
   * Validates a request's JWT against client-provided device fingerprint
   */
  validateGuestToken(token: string, currentFingerprint: string): { chargerId: string; connectorId: number } {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as any;
      
      const currentHashedFingerprint = createHash('sha256').update(currentFingerprint).digest('hex');
      if (decoded.claimSignature !== currentHashedFingerprint) {
        this.logger.warn(`Security alert: Token device fingerprint mismatch.`);
        throw new UnauthorizedException('Session binding validation failed.');
      }

      return {
        chargerId: decoded.chargerId,
        connectorId: decoded.connectorId,
      };
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired guest session.');
    }
  }

  private buildGuestClaimUrl(req: Request, rawToken: string): string {
    if (this.guestAppUrl) {
      return `${this.guestAppUrl.replace(/\/$/, '')}/claim?token=${rawToken}`;
    }

    const originHeader = req.get('origin');
    const refererHeader = req.get('referer');

    if (originHeader) {
      const origin = new URL(originHeader);
      return `${origin.protocol}//${origin.hostname}:3002/claim?token=${rawToken}`;
    }

    if (refererHeader) {
      const referer = new URL(refererHeader);
      return `${referer.protocol}//${referer.hostname}:3002/claim?token=${rawToken}`;
    }

    const host = req.get('host') || 'localhost:4001';
    const protocol = req.protocol || 'http';
    const hostname = host.split(':')[0];
    return `${protocol}://${hostname}:3002/claim?token=${rawToken}`;
  }
}

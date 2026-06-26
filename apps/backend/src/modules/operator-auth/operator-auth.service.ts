import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import {
  ChangeOperatorPinRequest,
  OperatorLoginResponse,
  OperatorProfile,
  RfidCard,
} from '@packages/shared';
import { RfidService } from '../charging/rfid.service';
import { PrismaService } from '../database/prisma.service';
import { config } from '../../config/app.config';
import {
  findUserByRfidTag,
  isOperatorRole,
  userToOperatorProfile,
} from '../users/user.mapper';
import { hashPassword, verifyPassword, verifySecret, hashSecret } from '../../utils/password.util';

export interface OperatorJwtPayload {
  type: 'operator';
  rfidCardId: string;
  userId?: number;
  role?: string;
}

@Injectable()
export class OperatorAuthService {
  private readonly logger = new Logger(OperatorAuthService.name);

  constructor(
    private readonly rfidService: RfidService,
    private readonly prisma: PrismaService,
  ) {}

  toProfile(card: RfidCard): OperatorProfile {
    const remaining = Math.max(0, card.monthlyKwhLimit - card.currentMonthKwhConsumed);
    return {
      rfid_tag: card.rfidCardId,
      cardholderName: card.cardholderName,
      username: card.username,
      role: card.role,
      balance: parseFloat(remaining.toFixed(4)),
      base_balance_kwh: card.monthlyKwhLimit,
      currentMonthKwhConsumed: card.currentMonthKwhConsumed,
      isActive: card.isActive,
    };
  }

  async login(identifier: string, pin: string): Promise<OperatorLoginResponse> {
    if (this.prisma.isReady()) {
      return this.loginMysql(identifier, pin);
    }
    return this.loginFile(identifier, pin);
  }

  private async loginFile(identifier: string, pin: string): Promise<OperatorLoginResponse> {
    const card = await this.rfidService.findByIdentifier(identifier);
    if (!card) throw new UnauthorizedException('Invalid RFID or username.');
    if (!card.isActive) throw new UnauthorizedException('Operator account is deactivated.');
    if (!card.pinHash) throw new UnauthorizedException('Operator PIN not configured.');
    if (!verifySecret(pin, card.pinHash)) {
      throw new UnauthorizedException('Invalid RFID or PIN.');
    }
    const publicCard = this.rfidService.toPublicCard(card);
    const token = this.signToken({
      type: 'operator',
      rfidCardId: publicCard.rfidCardId,
      role: publicCard.role,
    });
    return { token, user: this.toProfile(publicCard) };
  }

  private async loginMysql(identifier: string, pin: string): Promise<OperatorLoginResponse> {
    const trimmed = identifier.trim();
    let user = await this.prisma.user.findFirst({ where: { username: trimmed } });
    if (!user) {
      user = await findUserByRfidTag(this.prisma, trimmed);
    }
    if (!user || !user.is_active || !isOperatorRole(user.role)) {
      throw new UnauthorizedException('Invalid RFID or PIN.');
    }
    if (!verifyPassword(pin, user.hashed_password)) {
      throw new UnauthorizedException('Invalid RFID or PIN.');
    }
    if (!user.rfid_tag) {
      throw new UnauthorizedException('Operator RFID tag not assigned.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login: new Date() },
    });
    const token = this.signToken({
      type: 'operator',
      rfidCardId: user.rfid_tag.toUpperCase(),
      userId: user.id,
      role: user.role,
    });
    return { token, user: userToOperatorProfile(user) };
  }

  private signToken(payload: OperatorJwtPayload): string {
    return jwt.sign(payload, config.jwtSecret, { expiresIn: `${config.jwtExpireMinutes}m` });
  }

  verifyToken(token: string): OperatorJwtPayload {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as OperatorJwtPayload;
      if (decoded.type !== 'operator') {
        throw new UnauthorizedException('Invalid operator token.');
      }
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired operator session.');
    }
  }

  async getProfile(rfidCardId: string, userId?: number): Promise<OperatorProfile> {
    if (this.prisma.isReady() && userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('Operator not found.');
      return userToOperatorProfile(user);
    }
    const card = await this.rfidService.getById(rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');
    return this.toProfile(card);
  }

  async changePin(rfidCardId: string, body: ChangeOperatorPinRequest, userId?: number): Promise<{ success: boolean }> {
    if (this.prisma.isReady() && userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('Operator not found.');
      if (!verifyPassword(body.currentPin, user.hashed_password)) {
        throw new UnauthorizedException('Current PIN is incorrect.');
      }
      if (!body.newPin || body.newPin.length < 4) {
        throw new BadRequestException('New PIN must be at least 4 characters.');
      }
      await this.prisma.user.update({
        where: { id: userId },
        data: { hashed_password: hashPassword(body.newPin), password_change: 1 },
      });
      return { success: true };
    }
    const record = await this.rfidService.getRecordById(rfidCardId);
    if (!record?.pinHash) throw new BadRequestException('PIN not configured.');
    if (!verifySecret(body.currentPin, record.pinHash)) {
      throw new UnauthorizedException('Current PIN is incorrect.');
    }
    if (!body.newPin || body.newPin.length < 4) {
      throw new BadRequestException('New PIN must be at least 4 characters.');
    }
    await this.rfidService.updatePin(rfidCardId, hashSecret(body.newPin));
    return { success: true };
  }
}

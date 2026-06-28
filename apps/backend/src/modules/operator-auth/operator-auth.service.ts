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
import { hashSecret, verifySecret } from '../../utils/password.util';

export interface OperatorJwtPayload {
  type: 'operator';
  rfidCardId: string;
  role?: string;
}

@Injectable()
export class OperatorAuthService {
  private readonly logger = new Logger(OperatorAuthService.name);
  private readonly jwtSecret =
    process.env.OPERATOR_JWT_SECRET || process.env.JWT_SECRET || 'super_secret_ephemeral_jwt_key_1234';
  private readonly jwtExpireMinutes = Number(process.env.OPERATOR_JWT_EXPIRE_MINUTES) || 480;

  constructor(private readonly rfidService: RfidService) {}

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

  private signToken(payload: OperatorJwtPayload): string {
    return jwt.sign(payload, this.jwtSecret, { expiresIn: `${this.jwtExpireMinutes}m` });
  }

  verifyToken(token: string): OperatorJwtPayload {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as OperatorJwtPayload;
      if (decoded.type !== 'operator') {
        throw new UnauthorizedException('Invalid operator token.');
      }
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired operator session.');
    }
  }

  async getProfile(rfidCardId: string): Promise<OperatorProfile> {
    const card = await this.rfidService.getById(rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');
    return this.toProfile(card);
  }

  async changePin(rfidCardId: string, body: ChangeOperatorPinRequest): Promise<{ success: boolean }> {
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

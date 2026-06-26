import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RfidCard, CreateRfidRequest, UpdateRfidRequest } from '@packages/shared';
import { hashPassword, hashSecret } from '../../utils/password.util';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../database/prisma.service';
import { config } from '../../config/app.config';
import { findUserByRfidTag, isOperatorRole, userToRfidCard } from '../users/user.mapper';

export interface RfidCardRecord extends RfidCard {
  pinHash?: string;
}

@Injectable()
export class RfidService {
  private readonly logger = new Logger(RfidService.name);
  private readonly filePath = path.join(process.cwd(), 'rfids.json');
  private cards: RfidCardRecord[] = [];

  constructor(
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {
    if (!this.prisma.isReady()) {
      this.loadCards();
    }
  }

  private loadCards() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.cards = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.logger.log(`Loaded ${this.cards.length} RFID cards from rfids.json`);
      } else {
        this.cards = [];
        this.saveCards();
      }
    } catch (error) {
      this.logger.error('Failed to load RFID cards:', error);
      this.cards = [];
    }
  }

  private saveCards() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.cards, null, 2), 'utf-8');
  }

  toPublicCard(card: RfidCardRecord): RfidCard {
    const { pinHash: _p, ...publicCard } = card;
    return publicCard;
  }

  private checkAndResetQuota(card: RfidCardRecord): boolean {
    const now = new Date();
    const lastReset = card.lastResetDate ? new Date(card.lastResetDate) : now;
    if (now.getFullYear() !== lastReset.getFullYear() || now.getMonth() !== lastReset.getMonth()) {
      card.currentMonthKwhConsumed = 0;
      card.lastResetDate = now.toISOString();
      return true;
    }
    return false;
  }

  async getAll(): Promise<RfidCard[]> {
    if (this.prisma.isReady()) {
      const users = await this.prisma.user.findMany({
        where: { role: { in: ['staff', 'employee', 'operator'] } },
        orderBy: { full_name: 'asc' },
      });
      return users.filter((u) => u.rfid_tag).map(userToRfidCard);
    }
    let changed = false;
    for (const card of this.cards) {
      if (this.checkAndResetQuota(card)) changed = true;
    }
    if (changed) this.saveCards();
    return this.cards.map((c) => this.toPublicCard(c));
  }

  async getById(rfidCardId: string): Promise<RfidCard | null> {
    if (this.prisma.isReady()) {
      const user = await findUserByRfidTag(this.prisma, rfidCardId);
      return user && isOperatorRole(user.role) ? userToRfidCard(user) : null;
    }
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) return null;
    if (this.checkAndResetQuota(card)) this.saveCards();
    return this.toPublicCard(card);
  }

  async getRecordById(rfidCardId: string): Promise<RfidCardRecord | null> {
    return this.findByIdentifier(rfidCardId);
  }

  async findByIdentifier(identifier: string): Promise<RfidCardRecord | null> {
    if (this.prisma.isReady()) {
      const card = await this.getById(identifier);
      if (!card) {
        const user = await this.prisma.user.findFirst({
          where: { username: identifier.trim() },
        });
        if (user?.rfid_tag) return userToRfidCard(user) as RfidCardRecord;
        return null;
      }
      return card as RfidCardRecord;
    }
    const normalized = identifier.trim();
    const upper = normalized.toUpperCase();
    const byRfid = this.cards.find((c) => c.rfidCardId.toUpperCase() === upper);
    if (byRfid) {
      if (this.checkAndResetQuota(byRfid)) this.saveCards();
      return byRfid;
    }
    const byUsername = this.cards.find((c) => c.username?.toLowerCase() === normalized.toLowerCase());
    if (byUsername) {
      if (this.checkAndResetQuota(byUsername)) this.saveCards();
      return byUsername;
    }
    return null;
  }

  async register(dto: CreateRfidRequest): Promise<RfidCard> {
    if (this.prisma.isReady()) {
      return this.registerMysql(dto);
    }
    const existing = await this.getById(dto.rfidCardId);
    if (existing) throw new BadRequestException(`RFID Card ${dto.rfidCardId} is already registered.`);
    const defaultLimit = this.settings.get().defaultMonthlyKwhLimit;
    const newCard: RfidCardRecord = {
      rfidCardId: dto.rfidCardId.toUpperCase(),
      cardholderName: dto.cardholderName,
      monthlyKwhLimit: dto.monthlyKwhLimit ?? defaultLimit,
      currentMonthKwhConsumed: 0,
      lastResetDate: new Date().toISOString(),
      isActive: true,
      username: dto.username?.trim() || undefined,
      role: dto.role ?? 'operator',
      pinHash: dto.pin ? hashSecret(dto.pin) : undefined,
    };
    this.cards.push(newCard);
    this.saveCards();
    return this.toPublicCard(newCard);
  }

  private async registerMysql(dto: CreateRfidRequest): Promise<RfidCard> {
    const rfid = dto.rfidCardId.trim().toUpperCase();
    const existing = await findUserByRfidTag(this.prisma, rfid);
    if (existing) throw new BadRequestException(`RFID ${rfid} already registered.`);
    const username = (dto.username || dto.cardholderName).trim().toLowerCase().replace(/\s+/g, '_');
    const dup = await this.prisma.user.findFirst({ where: { username } });
    if (dup) throw new BadRequestException(`Username ${username} already in use.`);
    const balance = dto.monthlyKwhLimit ?? config.operatorBaseBalance;
    const email = `${username}@operators.local`;
    const user = await this.prisma.user.create({
      data: {
        username,
        email,
        full_name: dto.cardholderName,
        hashed_password: hashPassword(dto.pin || '1234'),
        role: 'staff',
        rfid_tag: rfid,
        is_active: true,
        is_verified: true,
        balance,
        registration_source: 'kiosk_operators',
      },
    });
    this.logger.log(`Registered operator in MySQL: ${user.username} (${rfid})`);
    return userToRfidCard(user);
  }

  async update(rfidCardId: string, dto: UpdateRfidRequest): Promise<RfidCard> {
    if (this.prisma.isReady()) {
      return this.updateMysql(rfidCardId, dto);
    }
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    if (dto.cardholderName !== undefined) card.cardholderName = dto.cardholderName;
    if (dto.monthlyKwhLimit !== undefined) card.monthlyKwhLimit = dto.monthlyKwhLimit;
    if (dto.isActive !== undefined) card.isActive = dto.isActive;
    if (dto.currentMonthKwhConsumed !== undefined) card.currentMonthKwhConsumed = dto.currentMonthKwhConsumed;
    if (dto.role !== undefined) card.role = dto.role;
    if (dto.pin) card.pinHash = hashSecret(dto.pin);
    if (dto.username !== undefined) card.username = dto.username.trim() || undefined;
    this.saveCards();
    return this.toPublicCard(card);
  }

  private async updateMysql(rfidCardId: string, dto: UpdateRfidRequest): Promise<RfidCard> {
    const user = await findUserByRfidTag(this.prisma, rfidCardId);
    if (!user) throw new NotFoundException(`Operator ${rfidCardId} not found.`);
    const data: Record<string, unknown> = {};
    if (dto.cardholderName !== undefined) data.full_name = dto.cardholderName;
    if (dto.isActive !== undefined) data.is_active = dto.isActive;
    if (dto.pin) data.hashed_password = hashPassword(dto.pin);
    if (dto.currentMonthKwhConsumed !== undefined && dto.currentMonthKwhConsumed === 0) {
      data.balance = config.operatorBaseBalance;
    }
    if (dto.monthlyKwhLimit !== undefined) {
      config.operatorBaseBalance = dto.monthlyKwhLimit;
      process.env.OPERATOR_BASE_BALANCE = String(dto.monthlyKwhLimit);
    }
    const updated = await this.prisma.user.update({ where: { id: user.id }, data });
    return userToRfidCard(updated);
  }

  async updatePin(rfidCardId: string, pinHash: string): Promise<void> {
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    card.pinHash = pinHash;
    this.saveCards();
  }

  async delete(rfidCardId: string): Promise<boolean> {
    if (this.prisma.isReady()) {
      const user = await findUserByRfidTag(this.prisma, rfidCardId);
      if (!user) throw new NotFoundException(`Operator ${rfidCardId} not found.`);
      await this.prisma.user.update({ where: { id: user.id }, data: { is_active: false } });
      return true;
    }
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => c.rfidCardId.toUpperCase() !== rfidCardId.toUpperCase());
    if (this.cards.length === before) throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    this.saveCards();
    return true;
  }

  async logUsage(rfidCardId: string, kwh: number): Promise<RfidCard> {
    if (this.prisma.isReady()) {
      const user = await findUserByRfidTag(this.prisma, rfidCardId);
      if (!user) throw new NotFoundException(`Operator ${rfidCardId} not found.`);
      const current = user.balance != null ? Number(user.balance) : 0;
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { balance: Math.max(0, current - kwh) },
      });
      return userToRfidCard(updated);
    }
    const card = await this.getRecordById(rfidCardId);
    if (!card) throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    card.currentMonthKwhConsumed = parseFloat((card.currentMonthKwhConsumed + kwh).toFixed(4));
    this.saveCards();
    return this.toPublicCard(card);
  }
}

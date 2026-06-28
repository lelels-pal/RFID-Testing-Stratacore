import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RfidCard, CreateRfidRequest, UpdateRfidRequest } from '@packages/shared';
import { hashSecret } from '../../utils/password.util';

export interface RfidCardRecord extends RfidCard {
  pinHash?: string;
}

@Injectable()
export class RfidService {
  private readonly logger = new Logger(RfidService.name);
  private readonly filePath = path.join(process.cwd(), 'rfids.json');
  private cards: RfidCardRecord[] = [];

  constructor() {
    this.loadCards();
  }

  private loadCards() {
    try {
      if (fs.existsSync(this.filePath)) {
        const fileContent = fs.readFileSync(this.filePath, 'utf-8');
        this.cards = JSON.parse(fileContent);
        this.logger.log(`Loaded ${this.cards.length} RFID cards from local persistence.`);
      } else {
        this.cards = [];
        this.saveCards();
        this.logger.log('Initialized empty RFID card registry.');
      }
    } catch (error) {
      this.logger.error('Failed to load RFID cards:', error);
      this.cards = [];
    }
  }

  private saveCards() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.cards, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Failed to save RFID cards:', error);
    }
  }

  toPublicCard(card: RfidCardRecord): RfidCard {
    const { pinHash: _pin, ...publicCard } = card;
    return publicCard;
  }

  private checkAndResetQuota(card: RfidCardRecord): boolean {
    const now = new Date();
    const lastReset = card.lastResetDate ? new Date(card.lastResetDate) : now;

    const isDifferentMonth =
      now.getFullYear() !== lastReset.getFullYear() ||
      now.getMonth() !== lastReset.getMonth();

    if (isDifferentMonth) {
      this.logger.log(`Auto-resetting monthly quota for card ${card.rfidCardId}. Previous Reset: ${card.lastResetDate}`);
      card.currentMonthKwhConsumed = 0;
      card.lastResetDate = now.toISOString();
      return true;
    }
    return false;
  }

  resetAllMonthlyQuotas(): number {
    let resetCount = 0;
    for (const card of this.cards) {
      if (this.checkAndResetQuota(card)) {
        resetCount += 1;
      }
    }
    if (resetCount > 0) {
      this.saveCards();
      this.logger.log(`Scheduled monthly reset applied to ${resetCount} card(s).`);
    }
    return resetCount;
  }

  async getAll(): Promise<RfidCard[]> {
    let changed = false;
    for (const card of this.cards) {
      if (this.checkAndResetQuota(card)) {
        changed = true;
      }
    }
    if (changed) {
      this.saveCards();
    }
    return this.cards.map((c) => this.toPublicCard(c));
  }

  async getById(rfidCardId: string): Promise<RfidCard | null> {
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) return null;

    if (this.checkAndResetQuota(card)) {
      this.saveCards();
    }
    return this.toPublicCard(card);
  }

  async getRecordById(rfidCardId: string): Promise<RfidCardRecord | null> {
    return this.findByIdentifier(rfidCardId);
  }

  async findByIdentifier(identifier: string): Promise<RfidCardRecord | null> {
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
    const existing = await this.getById(dto.rfidCardId);
    if (existing) {
      throw new BadRequestException(`RFID Card with ID ${dto.rfidCardId} is already registered.`);
    }

    const pin = dto.pin?.trim() || '1234';
    const newCard: RfidCardRecord = {
      rfidCardId: dto.rfidCardId.toUpperCase(),
      cardholderName: dto.cardholderName,
      monthlyKwhLimit: dto.monthlyKwhLimit,
      currentMonthKwhConsumed: 0,
      lastResetDate: new Date().toISOString(),
      isActive: true,
      username: dto.username?.trim() || undefined,
      role: dto.role ?? 'operator',
      pinHash: hashSecret(pin),
    };

    this.cards.push(newCard);
    this.saveCards();
    this.logger.log(`Successfully registered RFID Card: ${newCard.rfidCardId}`);
    return this.toPublicCard(newCard);
  }

  async update(rfidCardId: string, dto: UpdateRfidRequest): Promise<RfidCard> {
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    if (dto.cardholderName !== undefined) card.cardholderName = dto.cardholderName;
    if (dto.monthlyKwhLimit !== undefined) card.monthlyKwhLimit = dto.monthlyKwhLimit;
    if (dto.isActive !== undefined) card.isActive = dto.isActive;
    if (dto.currentMonthKwhConsumed !== undefined) card.currentMonthKwhConsumed = dto.currentMonthKwhConsumed;
    if (dto.role !== undefined) card.role = dto.role;
    if (dto.username !== undefined) card.username = dto.username.trim() || undefined;
    if (dto.pin) card.pinHash = hashSecret(dto.pin);

    this.checkAndResetQuota(card);
    this.saveCards();
    this.logger.log(`Updated RFID Card: ${rfidCardId}`);
    return this.toPublicCard(card);
  }

  async updatePin(rfidCardId: string, pinHash: string): Promise<void> {
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    card.pinHash = pinHash;
    this.saveCards();
  }

  async delete(rfidCardId: string): Promise<boolean> {
    const initialLength = this.cards.length;
    this.cards = this.cards.filter((c) => c.rfidCardId.toUpperCase() !== rfidCardId.toUpperCase());

    if (this.cards.length === initialLength) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    this.saveCards();
    this.logger.log(`Deleted RFID Card: ${rfidCardId}`);
    return true;
  }

  async logUsage(rfidCardId: string, kwh: number): Promise<RfidCard> {
    const card = this.cards.find((c) => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    if (this.checkAndResetQuota(card)) {
      this.saveCards();
    }

    card.currentMonthKwhConsumed = parseFloat((card.currentMonthKwhConsumed + kwh).toFixed(4));
    this.saveCards();
    return this.toPublicCard(card);
  }
}

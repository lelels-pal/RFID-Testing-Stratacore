import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RfidCard, CreateRfidRequest, UpdateRfidRequest } from '@packages/shared';

@Injectable()
export class RfidService {
  private readonly logger = new Logger(RfidService.name);
  private readonly filePath = path.join(process.cwd(), 'rfids.json');
  private cards: RfidCard[] = [];

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

  /**
   * Helper that checks if a card needs its monthly reset.
   * If yes, resets current consumption to 0 and saves.
   */
  private checkAndResetQuota(card: RfidCard): boolean {
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
    return this.cards;
  }

  async getById(rfidCardId: string): Promise<RfidCard | null> {
    const card = this.cards.find(c => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) return null;

    if (this.checkAndResetQuota(card)) {
      this.saveCards();
    }
    return card;
  }

  async register(dto: CreateRfidRequest): Promise<RfidCard> {
    const existing = await this.getById(dto.rfidCardId);
    if (existing) {
      throw new BadRequestException(`RFID Card with ID ${dto.rfidCardId} is already registered.`);
    }

    const newCard: RfidCard = {
      rfidCardId: dto.rfidCardId.toUpperCase(),
      cardholderName: dto.cardholderName,
      monthlyKwhLimit: dto.monthlyKwhLimit,
      currentMonthKwhConsumed: 0,
      lastResetDate: new Date().toISOString(),
      isActive: true,
    };

    this.cards.push(newCard);
    this.saveCards();
    this.logger.log(`Successfully registered RFID Card: ${newCard.rfidCardId}`);
    return newCard;
  }

  async update(rfidCardId: string, dto: UpdateRfidRequest): Promise<RfidCard> {
    const card = this.cards.find(c => c.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    if (!card) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    if (dto.cardholderName !== undefined) card.cardholderName = dto.cardholderName;
    if (dto.monthlyKwhLimit !== undefined) card.monthlyKwhLimit = dto.monthlyKwhLimit;
    if (dto.isActive !== undefined) card.isActive = dto.isActive;
    if (dto.currentMonthKwhConsumed !== undefined) card.currentMonthKwhConsumed = dto.currentMonthKwhConsumed;

    this.checkAndResetQuota(card);
    this.saveCards();
    this.logger.log(`Updated RFID Card: ${rfidCardId}`);
    return card;
  }

  async delete(rfidCardId: string): Promise<boolean> {
    const initialLength = this.cards.length;
    this.cards = this.cards.filter(c => c.rfidCardId.toUpperCase() !== rfidCardId.toUpperCase());
    
    if (this.cards.length === initialLength) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    this.saveCards();
    this.logger.log(`Deleted RFID Card: ${rfidCardId}`);
    return true;
  }

  async logUsage(rfidCardId: string, kwh: number): Promise<RfidCard> {
    const card = await this.getById(rfidCardId);
    if (!card) {
      throw new NotFoundException(`RFID Card ${rfidCardId} not found.`);
    }

    card.currentMonthKwhConsumed = parseFloat((card.currentMonthKwhConsumed + kwh).toFixed(4));
    this.saveCards();
    return card;
  }
}

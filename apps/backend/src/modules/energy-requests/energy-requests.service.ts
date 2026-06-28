import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CreateEnergyRequestBody, EnergyRequest, ReviewEnergyRequestBody } from '@packages/shared';
import { RfidService } from '../charging/rfid.service';

@Injectable()
export class EnergyRequestsService {
  private readonly logger = new Logger(EnergyRequestsService.name);
  private readonly filePath = path.join(process.cwd(), 'energy-requests.json');
  private requests: EnergyRequest[] = [];

  constructor(private readonly rfidService: RfidService) {
    this.loadFile();
  }

  private loadFile() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.requests = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      } else {
        fs.writeFileSync(this.filePath, '[]', 'utf-8');
      }
    } catch {
      this.requests = [];
    }
  }

  private saveFile() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.requests, null, 2), 'utf-8');
  }

  async create(rfidCardId: string, body: CreateEnergyRequestBody): Promise<EnergyRequest> {
    if (!body.kwhAmount || body.kwhAmount <= 0) {
      throw new BadRequestException('kwhAmount must be greater than zero.');
    }

    const card = await this.rfidService.getById(rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');

    const pending = this.requests.filter(
      (r) => r.rfidCardId.toUpperCase() === rfidCardId.toUpperCase() && r.status === 'pending',
    ).length;
    if (pending >= 3) throw new BadRequestException('Too many pending requests.');

    const req: EnergyRequest = {
      id: randomUUID(),
      rfidCardId: card.rfidCardId,
      cardholderName: card.cardholderName,
      kwhAmount: body.kwhAmount,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.requests.unshift(req);
    this.saveFile();
    this.logger.log(`Energy request created: ${req.id} for ${req.rfidCardId} (+${req.kwhAmount} kWh)`);
    return req;
  }

  async list(rfidCardId?: string): Promise<EnergyRequest[]> {
    if (rfidCardId) {
      return this.requests.filter((r) => r.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    }
    return [...this.requests];
  }

  async approve(id: string, body: ReviewEnergyRequestBody): Promise<EnergyRequest> {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new NotFoundException('Energy request not found.');
    if (req.status !== 'pending') throw new BadRequestException('Request already reviewed.');
    const card = await this.rfidService.getById(req.rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');

    const remaining = card.monthlyKwhLimit - card.currentMonthKwhConsumed;
    if (remaining + req.kwhAmount > card.monthlyKwhLimit) {
      throw new BadRequestException(
        `Approval would exceed monthly allowance (${card.monthlyKwhLimit} kWh).`,
      );
    }

    const newConsumed = Math.max(0, card.currentMonthKwhConsumed - req.kwhAmount);
    await this.rfidService.update(req.rfidCardId, {
      currentMonthKwhConsumed: newConsumed,
    });
    req.status = 'accepted';
    req.adminNote = body.adminNote;
    req.reviewedAt = new Date().toISOString();
    this.saveFile();
    this.logger.log(`Energy request approved: ${req.id} (+${req.kwhAmount} kWh to ${req.rfidCardId})`);
    return req;
  }

  async decline(id: string, body: ReviewEnergyRequestBody): Promise<EnergyRequest> {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new NotFoundException('Energy request not found.');
    if (req.status !== 'pending') throw new BadRequestException('Request already reviewed.');
    req.status = 'declined';
    req.adminNote = body.adminNote;
    req.reviewedAt = new Date().toISOString();
    this.saveFile();
    return req;
  }
}

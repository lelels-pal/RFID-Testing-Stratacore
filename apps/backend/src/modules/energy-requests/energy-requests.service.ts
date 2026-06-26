import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CreateEnergyRequestBody, EnergyRequest, ReviewEnergyRequestBody } from '@packages/shared';
import { RfidService } from '../charging/rfid.service';
import { PrismaService } from '../database/prisma.service';
import { findUserByRfidTag } from '../users/user.mapper';

@Injectable()
export class EnergyRequestsService {
  private readonly logger = new Logger(EnergyRequestsService.name);
  private readonly filePath = path.join(process.cwd(), 'energy-requests.json');
  private requests: EnergyRequest[] = [];

  constructor(
    private readonly rfidService: RfidService,
    private readonly prisma: PrismaService,
  ) {
    if (!this.prisma.isReady()) {
      this.loadFile();
    }
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

  private mapDbRow(row: {
    id: number;
    user_id: number;
    kwh_amount: unknown;
    status: string;
    admin_note: string | null;
    created_at: Date;
    reviewed_at: Date | null;
    user?: { full_name: string; rfid_tag: string | null };
  }): EnergyRequest {
    return {
      id: String(row.id),
      rfidCardId: row.user?.rfid_tag || '',
      cardholderName: row.user?.full_name || '',
      kwhAmount: Number(row.kwh_amount),
      status: row.status as EnergyRequest['status'],
      adminNote: row.admin_note || undefined,
      createdAt: row.created_at.toISOString(),
      reviewedAt: row.reviewed_at?.toISOString(),
    };
  }

  async create(rfidCardId: string, body: CreateEnergyRequestBody): Promise<EnergyRequest> {
    if (!body.kwhAmount || body.kwhAmount <= 0) {
      throw new BadRequestException('kwhAmount must be greater than zero.');
    }

    if (this.prisma.isReady()) {
      const user = await findUserByRfidTag(this.prisma, rfidCardId);
      if (!user) throw new NotFoundException('Operator not found.');
      const pending = await this.prisma.operatorEnergyRequest.count({
        where: { user_id: user.id, status: 'pending' },
      });
      if (pending >= 3) throw new BadRequestException('Too many pending requests.');
      const row = await this.prisma.operatorEnergyRequest.create({
        data: { user_id: user.id, kwh_amount: body.kwhAmount, status: 'pending' },
        include: { user: true },
      });
      return this.mapDbRow({ ...row, user: row.user });
    }

    const card = await this.rfidService.getById(rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');
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
    return req;
  }

  async list(rfidCardId?: string): Promise<EnergyRequest[]> {
    if (this.prisma.isReady()) {
      const where = rfidCardId
        ? { user: { rfid_tag: rfidCardId } }
        : {};
      const rows = await this.prisma.operatorEnergyRequest.findMany({
        where,
        include: { user: true },
        orderBy: { created_at: 'desc' },
        take: 200,
      });
      return rows.map((r) => this.mapDbRow(r));
    }
    if (rfidCardId) {
      return this.requests.filter((r) => r.rfidCardId.toUpperCase() === rfidCardId.toUpperCase());
    }
    return [...this.requests];
  }

  async approve(id: string, body: ReviewEnergyRequestBody, reviewerId?: number): Promise<EnergyRequest> {
    if (this.prisma.isReady()) {
      const row = await this.prisma.operatorEnergyRequest.findUnique({
        where: { id: Number(id) },
        include: { user: true },
      });
      if (!row) throw new NotFoundException('Energy request not found.');
      if (row.status !== 'pending') throw new BadRequestException('Request already reviewed.');
      const current = row.user.balance != null ? Number(row.user.balance) : 0;
      await this.prisma.user.update({
        where: { id: row.user_id },
        data: { balance: current + Number(row.kwh_amount) },
      });
      const updated = await this.prisma.operatorEnergyRequest.update({
        where: { id: row.id },
        data: {
          status: 'accepted',
          admin_note: body.adminNote,
          reviewed_at: new Date(),
          reviewed_by_user_id: reviewerId ?? null,
        },
        include: { user: true },
      });
      return this.mapDbRow(updated);
    }
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new NotFoundException('Energy request not found.');
    if (req.status !== 'pending') throw new BadRequestException('Request already reviewed.');
    const card = await this.rfidService.getById(req.rfidCardId);
    if (!card) throw new NotFoundException('Operator not found.');
    await this.rfidService.update(req.rfidCardId, {
      monthlyKwhLimit: card.monthlyKwhLimit + req.kwhAmount,
    });
    req.status = 'accepted';
    req.adminNote = body.adminNote;
    req.reviewedAt = new Date().toISOString();
    this.saveFile();
    return req;
  }

  async decline(id: string, body: ReviewEnergyRequestBody, reviewerId?: number): Promise<EnergyRequest> {
    if (this.prisma.isReady()) {
      const row = await this.prisma.operatorEnergyRequest.findUnique({
        where: { id: Number(id) },
        include: { user: true },
      });
      if (!row) throw new NotFoundException('Energy request not found.');
      if (row.status !== 'pending') throw new BadRequestException('Request already reviewed.');
      const updated = await this.prisma.operatorEnergyRequest.update({
        where: { id: row.id },
        data: {
          status: 'declined',
          admin_note: body.adminNote,
          reviewed_at: new Date(),
          reviewed_by_user_id: reviewerId ?? null,
        },
        include: { user: true },
      });
      return this.mapDbRow(updated);
    }
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new NotFoundException('Energy request not found.');
    req.status = 'declined';
    req.adminNote = body.adminNote;
    req.reviewedAt = new Date().toISOString();
    this.saveFile();
    return req;
  }
}

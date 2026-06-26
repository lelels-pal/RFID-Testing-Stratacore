import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class ChargersDbService {
  constructor(private readonly prisma: PrismaService) {}

  async listAll() {
    if (!this.prisma.isReady()) return [];
    return this.prisma.charger.findMany({
      include: { station: true },
      orderBy: { charger_id: 'asc' },
    });
  }

  async listChargerIds(): Promise<string[]> {
    const rows = await this.listAll();
    return rows.map((c) => c.charger_id);
  }

  async getByChargerId(chargerId: string) {
    if (!this.prisma.isReady()) return null;
    return this.prisma.charger.findUnique({
      where: { charger_id: chargerId },
      include: { station: true },
    });
  }
}

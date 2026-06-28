import { Body, Controller, Get, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { ChargingService } from '../charging/charging.service';
import { OperatorGuard, getOperatorUser } from './operator-auth.guards';
import { RfidService } from '../charging/rfid.service';
import { RfidStartRequest } from '@packages/shared';
import { isRfidQuotaBlocked, rfidQuotaBlockedMessage } from '../../utils/rfid-quota.util';

@Controller('api/v1/operator/charging')
export class OperatorChargingController {
  constructor(
    private readonly chargingService: ChargingService,
    private readonly rfidService: RfidService,
  ) {}

  @Get('chargers')
  @UseGuards(OperatorGuard)
  async listChargers(@Query('ids') ids?: string) {
    const chargerIds = ids
      ? ids.split(',').map((id) => id.trim()).filter(Boolean)
      : [];
    if (chargerIds.length === 0) {
      throw new BadRequestException('Query parameter "ids" is required (comma-separated charger IDs).');
    }
    return this.chargingService.getChargersStatus(chargerIds);
  }

  @Post('start')
  @UseGuards(OperatorGuard)
  async start(@Req() req: Request, @Body() body: Omit<RfidStartRequest, 'rfidCardId'>) {
    const { rfidCardId } = getOperatorUser(req);
    if (!body.chargerId || body.connectorId === undefined) {
      throw new BadRequestException('chargerId and connectorId are required.');
    }
    const card = await this.rfidService.getById(rfidCardId);
    if (!card) throw new BadRequestException('RFID Card not registered.');
    if (!card.isActive) throw new BadRequestException('RFID Card is deactivated.');
    if (isRfidQuotaBlocked(card)) {
      throw new BadRequestException(rfidQuotaBlockedMessage(card));
    }
    return this.chargingService.startRfidSession(body.chargerId, body.connectorId, rfidCardId);
  }

  @Post('stop')
  @UseGuards(OperatorGuard)
  async stop(@Req() req: Request, @Body() body: { chargerId: string; transactionId?: number }) {
    getOperatorUser(req);
    if (!body?.chargerId) throw new BadRequestException('chargerId is required.');
    return this.chargingService.triggerRemoteStop(body.chargerId, body.transactionId);
  }
}

import { Controller, Post, Get, Put, Delete, Body, Param, Headers, Query, BadRequestException, UnauthorizedException, UseGuards, Req } from '@nestjs/common';
import { Request } from 'express';
import { ChargingService } from './charging.service';
import { AuthService } from '../auth/auth.service';
import { RfidService } from './rfid.service';
import { PaymentsService } from '../payments/payments.service';
import { ChargersConfigService } from '../chargers/chargers-config.service';
import { AdminAuthGuard } from '../admin-auth/admin-auth.guard';
import { CreateCheckoutRequest, CreateRfidRequest, UpdateRfidRequest, RfidStartRequest } from '@packages/shared';

@Controller('api/v1/charging')
export class ChargingController {
  constructor(
    private readonly chargingService: ChargingService,
    private readonly authService: AuthService,
    private readonly rfidService: RfidService,
    private readonly paymentsService: PaymentsService,
    private readonly chargersConfig: ChargersConfigService,
  ) {}

  @Get('site-config')
  getSiteConfig() {
    return this.chargersConfig.getSiteConfig();
  }

  @Get('rfid')
  @UseGuards(AdminAuthGuard)
  async listRfids() {
    return this.rfidService.getAll();
  }

  @Get('ocpp-trace')
  @UseGuards(AdminAuthGuard)
  async getOcppTrace(
    @Query('limit') limit?: string,
    @Query('rfidOnly') rfidOnly?: string,
  ) {
    const parsedLimit = limit ? Number(limit) : 50;
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 50;
    return this.chargingService.getOcppTrace(safeLimit, rfidOnly === 'true');
  }

  @Get('chargers')
  @UseGuards(AdminAuthGuard)
  async listChargers(@Query('ids') ids?: string) {
    const chargerIds = ids
      ? ids.split(',').map((id) => id.trim()).filter(Boolean)
      : [];
    if (chargerIds.length === 0) {
      throw new BadRequestException('Query parameter "ids" is required (comma-separated charger IDs).');
    }
    return this.chargingService.getChargersStatus(chargerIds);
  }

  @Post('rfid')
  @UseGuards(AdminAuthGuard)
  async registerRfid(@Body() body: CreateRfidRequest) {
    if (!body.rfidCardId || !body.cardholderName || body.monthlyKwhLimit === undefined) {
      throw new BadRequestException('rfidCardId, cardholderName, and monthlyKwhLimit are required.');
    }
    return this.rfidService.register(body);
  }

  @Put('rfid/:cardId')
  @UseGuards(AdminAuthGuard)
  async updateRfid(@Param('cardId') cardId: string, @Body() body: UpdateRfidRequest) {
    return this.rfidService.update(cardId, body);
  }

  @Delete('rfid/:cardId')
  @UseGuards(AdminAuthGuard)
  async deleteRfid(@Param('cardId') cardId: string) {
    return this.rfidService.delete(cardId);
  }

  @Post('rfid/start')
  @UseGuards(AdminAuthGuard)
  async startRfidSession(@Body() body: RfidStartRequest) {
    if (!body.chargerId || body.connectorId === undefined || !body.rfidCardId) {
      throw new BadRequestException('chargerId, connectorId, and rfidCardId are required.');
    }

    const card = await this.rfidService.getById(body.rfidCardId);
    if (!card) {
      throw new BadRequestException('RFID Card not registered.');
    }
    if (!card.isActive) {
      throw new BadRequestException('RFID Card is deactivated.');
    }
    if (card.currentMonthKwhConsumed >= card.monthlyKwhLimit) {
      throw new BadRequestException(`Card quota exhausted (${card.currentMonthKwhConsumed.toFixed(2)} / ${card.monthlyKwhLimit} kWh).`);
    }

    return this.chargingService.startRfidSession(
      body.chargerId,
      body.connectorId,
      card.rfidCardId,
    );
  }

  @Post('checkout')
  async checkout(
    @Headers('authorization') authHeader: string,
    @Headers('x-device-fingerprint') fingerprint: string,
    @Body() body: CreateCheckoutRequest,
    @Req() req: Request,
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }

    const token = authHeader.split(' ')[1];
    const session = this.authService.validateGuestToken(token, fingerprint);

    if (session.chargerId !== body.chargerId || session.connectorId !== body.connectorId) {
      throw new BadRequestException('Requested charger details do not match active handshake.');
    }

    const guestAppOrigin = req.get('x-guest-app-origin') || req.get('origin') || undefined;
    return this.paymentsService.createCheckout(
      body.chargerId,
      body.connectorId,
      body.tariffPlanId,
      guestAppOrigin,
    );
  }

  @Post('stop')
  async stop(
    @Headers('authorization') authHeader: string,
    @Headers('x-device-fingerprint') fingerprint: string,
    @Body() body: { transactionId?: number },
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }

    const token = authHeader.split(' ')[1];
    const session = this.authService.validateGuestToken(token, fingerprint);

    return this.chargingService.triggerRemoteStop(session.chargerId, body?.transactionId);
  }

  @Post('kiosk/stop')
  @UseGuards(AdminAuthGuard)
  async kioskStop(@Body() body: { chargerId: string }) {
    if (!body?.chargerId) {
      throw new BadRequestException('chargerId is required.');
    }
    return this.chargingService.triggerRemoteStop(body.chargerId);
  }
}

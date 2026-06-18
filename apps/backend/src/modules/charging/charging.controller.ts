import { Controller, Post, Get, Put, Delete, Body, Param, Headers, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ChargingService } from './charging.service';
import { AuthService } from '../auth/auth.service';
import { RfidService } from './rfid.service';
import { CreateCheckoutRequest, CreateRfidRequest, UpdateRfidRequest, RfidStartRequest } from '@packages/shared';

@Controller('api/v1/charging')
export class ChargingController {
  constructor(
    private readonly chargingService: ChargingService,
    private readonly authService: AuthService,
    private readonly rfidService: RfidService
  ) {}

  @Get('rfid')
  async listRfids() {
    return this.rfidService.getAll();
  }

  @Post('rfid')
  async registerRfid(@Body() body: CreateRfidRequest) {
    if (!body.rfidCardId || !body.cardholderName || body.monthlyKwhLimit === undefined) {
      throw new BadRequestException('rfidCardId, cardholderName, and monthlyKwhLimit are required.');
    }
    return this.rfidService.register(body);
  }

  @Put('rfid/:cardId')
  async updateRfid(@Param('cardId') cardId: string, @Body() body: UpdateRfidRequest) {
    return this.rfidService.update(cardId, body);
  }

  @Delete('rfid/:cardId')
  async deleteRfid(@Param('cardId') cardId: string) {
    return this.rfidService.delete(cardId);
  }

  @Post('rfid/start')
  async startRfidSession(@Body() body: RfidStartRequest) {
    if (!body.chargerId || body.connectorId === undefined || !body.rfidCardId) {
      throw new BadRequestException('chargerId, connectorId, and rfidCardId are required.');
    }

    // 1. Verify Card Quota before letting session begin
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

    // 2. Delegate remote start trigger to service
    return this.chargingService.startRfidSession(
      body.chargerId,
      body.connectorId,
      card.rfidCardId
    );
  }

  @Post('checkout')
  async checkout(
    @Headers('authorization') authHeader: string,
    @Headers('x-device-fingerprint') fingerprint: string,
    @Body() body: CreateCheckoutRequest
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }

    const token = authHeader.split(' ')[1];
    
    // Validate session binding to prevent session hijacking
    const session = this.authService.validateGuestToken(token, fingerprint);

    if (session.chargerId !== body.chargerId || session.connectorId !== body.connectorId) {
      throw new BadRequestException('Requested charger details do not match active handshake.');
    }

    return this.chargingService.initiateCheckout(
      body.chargerId,
      body.connectorId,
      body.tariffPlanId
    );
  }

  @Post('stop')
  async stop(
    @Headers('authorization') authHeader: string,
    @Headers('x-device-fingerprint') fingerprint: string,
    @Body() body: { transactionId?: number }
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token missing.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }

    const token = authHeader.split(' ')[1];
    const session = this.authService.validateGuestToken(token, fingerprint);

    // transactionId is optional — the central system resolves the charger's
    // active transaction when the guest does not track one client-side.
    return this.chargingService.triggerRemoteStop(session.chargerId, body?.transactionId);
  }

  /**
   * Operator override stop, triggered from the trusted physical Kiosk screen.
   * The kiosk has no guest JWT, so this is keyed only by chargerId. Intended
   * for the local, attended kiosk device on the station network.
   */
  @Post('kiosk/stop')
  async kioskStop(@Body() body: { chargerId: string }) {
    if (!body?.chargerId) {
      throw new BadRequestException('chargerId is required.');
    }
    return this.chargingService.triggerRemoteStop(body.chargerId);
  }
}

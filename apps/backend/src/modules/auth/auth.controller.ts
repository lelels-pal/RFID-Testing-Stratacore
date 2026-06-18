import { Controller, Post, Body, Headers, BadRequestException, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

@Controller('api/v1/session')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('initiate')
  async initiate(
    @Body() body: { chargerId: string; connectorId: number },
    @Req() req: Request
  ) {
    if (!body.chargerId || typeof body.connectorId !== 'number') {
      throw new BadRequestException('chargerId and connectorId are required.');
    }
    return this.authService.initiateQrSession(body.chargerId, body.connectorId, req);
  }

  @Post('verify')
  async verify(
    @Body() body: { qrToken: string },
    @Headers('x-device-fingerprint') fingerprint: string
  ) {
    if (!body.qrToken) {
      throw new BadRequestException('qrToken is required.');
    }
    if (!fingerprint) {
      throw new BadRequestException('Security headers (x-device-fingerprint) missing.');
    }
    return this.authService.verifyQrSession(body.qrToken, fingerprint);
  }
}

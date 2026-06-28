import { Body, Controller, Get, Post, Put, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { ChangeOperatorPinRequest, OperatorLoginRequest } from '@packages/shared';
import { OperatorAuthService } from './operator-auth.service';
import { OperatorGuard, getOperatorUser } from './operator-auth.guards';

@Controller('api/v1')
export class OperatorAuthController {
  constructor(private readonly operatorAuth: OperatorAuthService) {}

  @Post('auth/operator/login')
  login(@Body() body: OperatorLoginRequest) {
    if (!body.identifier?.trim() || !body.pin) {
      throw new BadRequestException('identifier and pin are required');
    }
    return this.operatorAuth.login(body.identifier, body.pin);
  }

  @Get('operator/profile')
  @UseGuards(OperatorGuard)
  profile(@Req() req: Request) {
    const { rfidCardId } = getOperatorUser(req);
    return this.operatorAuth.getProfile(rfidCardId);
  }

  @Put('auth/operator/change-pin')
  @UseGuards(OperatorGuard)
  changePin(@Req() req: Request, @Body() body: ChangeOperatorPinRequest) {
    const { rfidCardId } = getOperatorUser(req);
    return this.operatorAuth.changePin(rfidCardId, body);
  }
}

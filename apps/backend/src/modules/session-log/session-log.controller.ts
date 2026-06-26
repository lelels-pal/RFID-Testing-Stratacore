import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SessionLogService } from './session-log.service';
import { AdminGuard, StaffOrAdminGuard } from '../admin-auth/admin-auth.guards';
import { OperatorGuard, getOperatorUser } from '../operator-auth/operator-auth.guards';

@Controller('api/v1/charging')
export class SessionLogController {
  constructor(private readonly sessionLog: SessionLogService) {}

  @Get('sessions')
  @UseGuards(StaffOrAdminGuard)
  async listAdmin(@Query('days') days?: string, @Query('rfidCardId') rfidCardId?: string) {
    const parsedDays = days ? Number(days) : 30;
    const safeDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 30;
    return this.sessionLog.list(safeDays, rfidCardId);
  }

  @Get('operator/sessions')
  @UseGuards(OperatorGuard)
  async listOperator(@Req() req: Request, @Query('days') days?: string) {
    const { rfidCardId } = getOperatorUser(req);
    const parsedDays = days ? Number(days) : 30;
    const safeDays = Number.isFinite(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 30;
    return this.sessionLog.list(safeDays, rfidCardId);
  }
}

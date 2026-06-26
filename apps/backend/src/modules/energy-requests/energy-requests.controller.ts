import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CreateEnergyRequestBody, ReviewEnergyRequestBody } from '@packages/shared';
import { EnergyRequestsService } from './energy-requests.service';
import { AdminGuard } from '../admin-auth/admin-auth.guards';
import { AdminJwtPayload } from '../admin-auth/admin-auth.service';
import { OperatorGuard, getOperatorUser } from '../operator-auth/operator-auth.guards';

@Controller('api/v1')
export class EnergyRequestsController {
  constructor(private readonly energyRequests: EnergyRequestsService) {}

  @Post('operator/energy-requests')
  @UseGuards(OperatorGuard)
  create(@Req() req: Request, @Body() body: CreateEnergyRequestBody) {
    const { rfidCardId } = getOperatorUser(req);
    return this.energyRequests.create(rfidCardId, body);
  }

  @Get('operator/energy-requests')
  @UseGuards(OperatorGuard)
  listMine(@Req() req: Request) {
    const { rfidCardId } = getOperatorUser(req);
    return this.energyRequests.list(rfidCardId);
  }

  @Get('admin/energy-requests')
  @UseGuards(AdminGuard)
  listAll() {
    return this.energyRequests.list();
  }

  @Post('admin/energy-requests/:id/approve')
  @UseGuards(AdminGuard)
  approve(@Req() req: Request, @Param('id') id: string, @Body() body: ReviewEnergyRequestBody) {
    const reviewerId = (req as Request & { adminUser?: AdminJwtPayload }).adminUser?.userId;
    return this.energyRequests.approve(id, body, reviewerId);
  }

  @Post('admin/energy-requests/:id/decline')
  @UseGuards(AdminGuard)
  decline(@Req() req: Request, @Param('id') id: string, @Body() body: ReviewEnergyRequestBody) {
    const reviewerId = (req as Request & { adminUser?: AdminJwtPayload }).adminUser?.userId;
    return this.energyRequests.decline(id, body, reviewerId);
  }
}

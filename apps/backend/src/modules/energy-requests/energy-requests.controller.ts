import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CreateEnergyRequestBody, ReviewEnergyRequestBody } from '@packages/shared';
import { EnergyRequestsService } from './energy-requests.service';
import { AdminAuthGuard } from '../admin-auth/admin-auth.guard';
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
  @UseGuards(AdminAuthGuard)
  listAll() {
    return this.energyRequests.list();
  }

  @Post('admin/energy-requests/:id/approve')
  @UseGuards(AdminAuthGuard)
  approve(@Param('id') id: string, @Body() body: ReviewEnergyRequestBody) {
    return this.energyRequests.approve(id, body);
  }

  @Post('admin/energy-requests/:id/decline')
  @UseGuards(AdminAuthGuard)
  decline(@Param('id') id: string, @Body() body: ReviewEnergyRequestBody) {
    return this.energyRequests.decline(id, body);
  }
}

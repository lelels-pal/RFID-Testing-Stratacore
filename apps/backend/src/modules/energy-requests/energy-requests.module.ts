import { Module } from '@nestjs/common';
import { EnergyRequestsService } from './energy-requests.service';
import { EnergyRequestsController } from './energy-requests.controller';
import { OperatorAuthModule } from '../operator-auth/operator-auth.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [OperatorAuthModule, AdminAuthModule],
  controllers: [EnergyRequestsController],
  providers: [EnergyRequestsService],
  exports: [EnergyRequestsService],
})
export class EnergyRequestsModule {}

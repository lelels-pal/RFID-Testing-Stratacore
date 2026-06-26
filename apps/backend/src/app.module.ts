import { Module } from '@nestjs/common';
import { RedisService } from './modules/redis/redis.service';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { ChargerGateway } from './modules/charging/charging.gateway';
import { ChargingService } from './modules/charging/charging.service';
import { ChargingController } from './modules/charging/charging.controller';
import { PaymentsController } from './modules/payments/payments.controller';
import { RfidService } from './modules/charging/rfid.service';
import { OcppTraceService } from './modules/charging/ocpp-trace.service';
import { HealthController } from './modules/health/health.controller';
import { WatchdogModule } from './modules/watchdog/watchdog.module';
import { SteveOcppAdapter } from '@packages/ocpp-adapter';
import { DatabaseModule } from './modules/database/database.module';
import { SettingsService } from './modules/settings/settings.service';
import { SettingsController } from './modules/settings/settings.controller';
import { AdminAuthService } from './modules/admin-auth/admin-auth.service';
import { AdminAuthController } from './modules/admin-auth/admin-auth.controller';
import { AdminGuard, StaffOrAdminGuard } from './modules/admin-auth/admin-auth.guards';
import { OperatorAuthService } from './modules/operator-auth/operator-auth.service';
import { OperatorAuthController } from './modules/operator-auth/operator-auth.controller';
import { OperatorChargingController } from './modules/operator-auth/operator-charging.controller';
import { OperatorGuard } from './modules/operator-auth/operator-auth.guards';
import { SessionLogService } from './modules/session-log/session-log.service';
import { SessionLogController } from './modules/session-log/session-log.controller';
import { EnergyRequestsService } from './modules/energy-requests/energy-requests.service';
import { EnergyRequestsController } from './modules/energy-requests/energy-requests.controller';
import { OperatorRfidService } from './modules/operator-rfid/operator-rfid.service';
import { ChargersDbService } from './modules/chargers/chargers-db.service';
import { PrismaService } from './modules/database/prisma.service';

@Module({
  imports: [WatchdogModule, DatabaseModule],
  controllers: [
    AuthController,
    ChargingController,
    PaymentsController,
    HealthController,
    SettingsController,
    AdminAuthController,
    OperatorAuthController,
    OperatorChargingController,
    SessionLogController,
    EnergyRequestsController,
  ],
  providers: [
    RedisService,
    AuthService,
    ChargerGateway,
    ChargingService,
    RfidService,
    OcppTraceService,
    SettingsService,
    AdminAuthService,
    AdminGuard,
    StaffOrAdminGuard,
    OperatorAuthService,
    OperatorGuard,
    SessionLogService,
    EnergyRequestsService,
    OperatorRfidService,
    ChargersDbService,
    {
      provide: 'IChargerController',
      inject: [RfidService, PrismaService, OperatorRfidService],
      useFactory: (
        rfidService: RfidService,
        prisma: PrismaService,
        operatorRfid: OperatorRfidService,
      ) => {
        return new SteveOcppAdapter({
          wsPort: Number(process.env.OCPP_WS_PORT || process.env.OCPP_PORT) || 9000,
          wsPath: process.env.OCPP_WS_PATH || '/ocpp',
          pricePerKwh: Number(process.env.PRICE_PER_KWH) || 15,
          onAuthorize: async (idTag: string) => {
            if (operatorRfid.isSystemBypassTag(idTag)) return 'Accepted';
            if (prisma.isReady()) {
              const result = await operatorRfid.authorizeStaff(idTag);
              return result.status;
            }
            const card = await rfidService.getById(idTag);
            if (!card) return 'Invalid';
            if (!card.isActive) return 'Blocked';
            if (card.currentMonthKwhConsumed >= card.monthlyKwhLimit) return 'Blocked';
            return 'Accepted';
          },
        });
      },
    },
  ],
})
export class AppModule {}

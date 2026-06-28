import { Module } from '@nestjs/common';
import { RedisService } from './modules/redis/redis.service';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { ChargerGateway } from './modules/charging/charging.gateway';
import { ChargingService } from './modules/charging/charging.service';
import { ChargingController } from './modules/charging/charging.controller';
import { PaymentsController } from './modules/payments/payments.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { MayaPaymentService } from './modules/payments/maya-payment.service';
import { RfidService } from './modules/charging/rfid.service';
import { OcppTraceService } from './modules/charging/ocpp-trace.service';
import { HealthController } from './modules/health/health.controller';
import { WatchdogModule } from './modules/watchdog/watchdog.module';
import { AdminAuthModule } from './modules/admin-auth/admin-auth.module';
import { ChargersConfigService } from './modules/chargers/chargers-config.service';
import { SteveOcppAdapter } from '@packages/ocpp-adapter';
import { OperatorAuthModule } from './modules/operator-auth/operator-auth.module';
import { EnergyRequestsModule } from './modules/energy-requests/energy-requests.module';
import { OperatorAuthController } from './modules/operator-auth/operator-auth.controller';
import { OperatorChargingController } from './modules/operator-auth/operator-charging.controller';
import { RfidQuotaResetScheduler } from './modules/charging/rfid-quota-reset.scheduler';
import { isRfidQuotaBlocked } from './utils/rfid-quota.util';
import { RfidModule } from './modules/charging/rfid.module';

@Module({
  imports: [AdminAuthModule, WatchdogModule, OperatorAuthModule, EnergyRequestsModule, RfidModule],
  controllers: [
    AuthController,
    ChargingController,
    PaymentsController,
    HealthController,
    OperatorAuthController,
    OperatorChargingController,
  ],
  providers: [
    RedisService,
    AuthService,
    ChargersConfigService,
    ChargerGateway,
    ChargingService,
    MayaPaymentService,
    PaymentsService,
    OcppTraceService,
    RfidQuotaResetScheduler,
    {
      provide: 'IChargerController',
      inject: [RfidService, ChargersConfigService],
      useFactory: (rfidService: RfidService, chargersConfig: ChargersConfigService) => {
        return new SteveOcppAdapter({
          wsPort: Number(process.env.OCPP_WS_PORT) || 9000,
          wsPath: process.env.OCPP_WS_PATH || '/ocpp',
          pricePerKwh: Number(process.env.PRICE_PER_KWH) || 15,
          allowedChargerIds: chargersConfig.getAllowedChargerIds(),
          onAuthorize: async (idTag: string) => {
            const card = await rfidService.getById(idTag);
            if (!card) return 'Invalid';
            if (!card.isActive) return 'Blocked';
            if (isRfidQuotaBlocked(card)) return 'Blocked';
            return 'Accepted';
          },
        });
      },
    },
  ],
})
export class AppModule {}

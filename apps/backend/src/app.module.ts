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

@Module({
  imports: [WatchdogModule],
  controllers: [
    AuthController,
    ChargingController,
    PaymentsController,
    HealthController,
  ],
  providers: [
    RedisService,
    AuthService,
    ChargerGateway,
    ChargingService,
    RfidService,
    OcppTraceService,
    // Dependency Injection Binding for the OCPP Adapter interface
    {
      provide: 'IChargerController',
      inject: [RfidService],
      useFactory: (rfidService: RfidService) => {
        return new SteveOcppAdapter({
          wsPort: Number(process.env.OCPP_WS_PORT) || 9000,
          wsPath: process.env.OCPP_WS_PATH || '/ocpp',
          pricePerKwh: Number(process.env.PRICE_PER_KWH) || 15,
          onAuthorize: async (idTag: string) => {
            const card = await rfidService.getById(idTag);
            if (!card) return 'Invalid';
            if (!card.isActive) return 'Blocked';
            if (card.currentMonthKwhConsumed >= card.monthlyKwhLimit) return 'Blocked';
            return 'Accepted';
          }
        });
      }
    }
  ],
})
export class AppModule {}




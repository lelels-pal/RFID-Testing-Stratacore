import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Trust reverse proxy (Caddy/nginx) for X-Forwarded-* headers
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins?.length ? corsOrigins : true,
    credentials: true,
  });

  const port = process.env.PORT || 4001;
  const ocppWsPort = process.env.OCPP_WS_PORT || 9000;
  const ocppWsPath = process.env.OCPP_WS_PATH || '/ocpp';
  await app.listen(port);
  logger.log(`EV Charging Backend API listening on port ${port}`);
  logger.log(`OCPP 1.6J Central System listening on ws://<HOST_IP>:${ocppWsPort}${ocppWsPath}/<chargerId>`);
}

bootstrap();

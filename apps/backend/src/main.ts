import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { config } from './config/app.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
  });

  const port = config.port;
  const ocppWsPort = config.ocppWsPort;
  const ocppWsPath = config.ocppWsPath;
  await app.listen(port);
  logger.log(`EV Charging Backend API listening on port ${port}`);
  logger.log(`Storage: ${config.mysqlEnabled ? 'MySQL (EdgeTechEV schema)' : 'file-based (rfids.json)'}`);
  logger.log(`OCPP 1.6J Central System listening on ws://<HOST_IP>:${ocppWsPort}${ocppWsPath}/<chargerId>`);
}

bootstrap();

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { isMysqlEnabled } from '../../config/app.config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private _ready = false;

  isReady(): boolean {
    return this._ready;
  }

  async onModuleInit() {
    if (!isMysqlEnabled()) {
      this.logger.log('MySQL disabled — file-based storage (set DB_HOST, DB_USER, DB_NAME).');
      return;
    }
    try {
      await this.$connect();
      this._ready = true;
      this.logger.log('Connected to MySQL (EdgeTechEV-compatible schema).');
    } catch (err) {
      this._ready = false;
      this.logger.error('MySQL connection failed — using file-based fallback.', err);
    }
  }

  async onModuleDestroy() {
    if (this._ready) {
      await this.$disconnect();
    }
  }
}

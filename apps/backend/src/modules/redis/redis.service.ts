import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

interface RedisValue {
  value: string;
  expiresAt: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly store = new Map<string, RedisValue>();
  private client: Redis | null = null;
  private useMemory = true;


  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV !== 'production' || !this.client || this.useMemory) return;
    try {
      await this.client.ping();
    } catch (err) {
      throw new Error(`Production startup blocked — Redis unreachable: ${(err as Error).message}`);
    }
  }

  constructor() {
    const redisUrl = process.env.REDIS_URL?.trim();
    if (redisUrl) {
      this.client = new Redis(redisUrl);
      this.useMemory = false;
      this.logger.log('Redis client initialized.');
      return;
    }

    if (process.env.NODE_ENV === 'production') {
      this.logger.warn('REDIS_URL is not set in production — using in-memory Redis fallback.');
    } else {
      this.logger.log('Redis Mock Service Initialized (no REDIS_URL).');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.client && !this.useMemory) {
      return this.client.get(key);
    }

    const item = this.store.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  async set(key: string, value: string, mode?: 'EX', ttlSeconds?: number): Promise<void> {
    if (this.client && !this.useMemory) {
      if (mode === 'EX' && ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
      return;
    }

    const expiresAt = mode === 'EX' && ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    if (this.client && !this.useMemory) {
      await this.client.del(key);
      return;
    }
    this.store.delete(key);
  }
}

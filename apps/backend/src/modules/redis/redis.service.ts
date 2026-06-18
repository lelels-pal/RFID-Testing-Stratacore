import { Injectable, Logger } from '@nestjs/common';

interface RedisValue {
  value: string;
  expiresAt: number;
}

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly store = new Map<string, RedisValue>();

  constructor() {
    this.logger.log('Redis Mock Service Initialized.');
  }

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;

    if (Date.now() > item.expiresAt) {
      this.logger.debug(`Key expired in Redis: ${key}`);
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  async set(key: string, value: string, mode?: 'EX', ttlSeconds?: number): Promise<void> {
    const expiresAt = mode === 'EX' && ttlSeconds 
      ? Date.now() + ttlSeconds * 1000 
      : Infinity;

    this.store.set(key, { value, expiresAt });
    this.logger.debug(`Redis SET: ${key} -> (Expires in ${ttlSeconds || 'never'}s)`);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
    this.logger.debug(`Redis DEL: ${key}`);
  }
}

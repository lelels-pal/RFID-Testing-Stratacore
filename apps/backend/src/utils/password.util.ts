import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

const DEFAULT_ROUNDS = 30000;

function ab64Decode(source: string): Buffer {
  const b64 = source.replace(/\./g, '+');
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(b64 + padding, 'base64');
}

function ab64Encode(data: Buffer): string {
  return data.toString('base64').replace(/\+/g, '.').replace(/=+$/, '');
}

function parsePasslibPbkdf2(storedHash: string): { rounds: number; saltStr: string; expectedStr: string } | null {
  const normalized = storedHash.startsWith('$') ? storedHash.slice(1) : storedHash;
  const match = normalized.match(/^pbkdf2[_-]sha256\$(\d+)\$([^$]+)\$(.+)$/i);
  if (!match) return null;
  return { rounds: parseInt(match[1], 10), saltStr: match[2], expectedStr: match[3] };
}

/** Passlib-compatible pbkdf2_sha256 (EdgeTechEV Python backend). */
export function hashPassword(password: string): string {
  const saltBytes = randomBytes(16);
  const digest = pbkdf2Sync(password, saltBytes, DEFAULT_ROUNDS, 32, 'sha256');
  return `pbkdf2_sha256$${DEFAULT_ROUNDS}$${ab64Encode(saltBytes)}$${ab64Encode(digest)}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) return false;

  const parsed = parsePasslibPbkdf2(storedHash);
  if (parsed) {
    try {
      const saltBytes = ab64Decode(parsed.saltStr);
      const expectedBytes = ab64Decode(parsed.expectedStr);
      const derived = pbkdf2Sync(password, saltBytes, parsed.rounds, expectedBytes.length, 'sha256');
      if (derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes)) {
        return true;
      }
      if (ab64Encode(derived) === parsed.expectedStr.replace(/=+$/, '')) return true;
    } catch {
      return false;
    }
  }

  if (storedHash.startsWith('$2')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
      return bcrypt.compareSync(password, storedHash);
    } catch {
      return false;
    }
  }

  // Stratacore file-mode scrypt hashes
  if (storedHash.startsWith('scrypt:')) {
    return verifyScryptSecret(password, storedHash);
  }

  return false;
}

function verifyScryptSecret(secret: string, stored: string): boolean {
  const { scryptSync } = require('crypto') as typeof import('crypto');
  const [, salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(secret, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function scryptSync(secret: string, salt: string, keyLen: number): Buffer {
  const { scryptSync: scrypt } = require('crypto') as typeof import('crypto');
  return scrypt(secret, salt, keyLen);
}

export function verifySecret(secret: string, stored: string): boolean {
  if (stored?.startsWith('scrypt:')) {
    return verifyScryptSecret(secret, stored);
  }
  return verifyPassword(secret, stored);
}

export function hashSecretOrPassword(secret: string, usePasslib: boolean): string {
  return usePasslib ? hashPassword(secret) : hashSecret(secret);
}

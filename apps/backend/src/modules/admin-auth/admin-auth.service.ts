import { Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AdminAuthService {
  private readonly jwtSecret =
    process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'super_secret_ephemeral_jwt_key_1234';
  private readonly username = process.env.ADMIN_USERNAME || 'admin';
  private readonly password = process.env.ADMIN_PASSWORD || '';

  login(
    username: string,
    password: string,
  ): { accessToken: string; username: string; role: string; expiresIn: string } {
    if (!this.password) {
      throw new UnauthorizedException('Admin login is not configured. Set ADMIN_PASSWORD.');
    }

    if (!this.safeEqual(username, this.username) || !this.safeEqual(password, this.password)) {
      throw new UnauthorizedException('Invalid admin credentials.');
    }

    const accessToken = jwt.sign({ sub: this.username, role: 'admin' }, this.jwtSecret, {
      expiresIn: '8h',
    });

    return {
      accessToken,
      username: this.username,
      role: 'admin',
      expiresIn: '8h',
    };
  }

  verifyToken(token: string): { username: string; role: string } {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as { sub?: string; role?: string };
      if (decoded.role !== 'admin' || !decoded.sub) {
        throw new UnauthorizedException('Admin access required.');
      }
      return { username: decoded.sub, role: decoded.role };
    } catch {
      throw new UnauthorizedException('Invalid or expired admin session.');
    }
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}

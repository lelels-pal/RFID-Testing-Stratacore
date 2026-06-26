import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import { AdminLoginResponse, AdminRole, AdminUser } from '@packages/shared';
import { hashSecret, verifyPassword, verifySecret } from '../../utils/password.util';
import { PrismaService } from '../database/prisma.service';
import { config } from '../../config/app.config';
import { isAdminRole } from '../users/user.mapper';

interface AdminUserRecord {
  username: string;
  passwordHash: string;
  role: AdminRole;
}

export interface AdminJwtPayload {
  type: 'admin';
  username: string;
  role: AdminRole;
  userId?: number;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly filePath = path.join(process.cwd(), 'admin-users.json');
  private users: AdminUserRecord[] = [];

  constructor(private readonly prisma: PrismaService) {
    if (!this.prisma.isReady()) {
      this.loadFileUsers();
    }
  }

  private loadFileUsers() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.users = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      } else {
        const masterHash = hashSecret(config.adminInitialPassword);
        this.users = [{ username: 'master', passwordHash: masterHash, role: 'master' }];
        fs.writeFileSync(this.filePath, JSON.stringify(this.users, null, 2), 'utf-8');
        this.logger.log('Initialized admin-users.json (master / ADMIN_DEFAULT_PASSWORD)');
      }
    } catch (err) {
      this.logger.error('Failed to load admin-users.json', err);
      this.users = [];
    }
  }

  async login(username: string, password: string): Promise<AdminLoginResponse> {
    if (this.prisma.isReady()) {
      return this.loginMysql(username, password);
    }
    return this.loginFile(username, password);
  }

  private loginFile(username: string, password: string): AdminLoginResponse {
    const user = this.users.find((u) => u.username === username.trim());
    if (!user || !verifySecret(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    const token = this.signToken({ type: 'admin', username: user.username, role: user.role });
    return { token, user: { username: user.username, role: user.role } };
  }

  private async loginMysql(username: string, password: string): Promise<AdminLoginResponse> {
    const trimmed = username.trim();
    let user = await this.prisma.user.findFirst({
      where: { OR: [{ username: trimmed }, { email: trimmed }] },
    });
    if (!user) {
      const users = await this.prisma.user.findMany({ where: { rfid_tag: { not: null } } });
      user = users.find((u) => u.rfid_tag?.toUpperCase() === trimmed.toUpperCase()) ?? null;
    }
    if (!user || !user.is_active || !isAdminRole(user.role)) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    if (!verifyPassword(password, user.hashed_password)) {
      throw new UnauthorizedException('Invalid username or password.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login: new Date() },
    });
    const role = user.role.toLowerCase() as AdminRole;
    const token = this.signToken({
      type: 'admin',
      username: user.username,
      role,
      userId: user.id,
    });
    return { token, user: { username: user.username, role } };
  }

  private signToken(payload: AdminJwtPayload): string {
    return jwt.sign(payload, config.jwtSecret, { expiresIn: `${config.jwtExpireMinutes}m` });
  }

  verifyToken(token: string): AdminJwtPayload {
    try {
      const decoded = jwt.verify(token, config.jwtSecret) as AdminJwtPayload;
      if (decoded.type !== 'admin') {
        throw new UnauthorizedException('Invalid admin token.');
      }
      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired admin session.');
    }
  }

  listUsers(): AdminUser[] {
    return this.users.map(({ username, role }) => ({ username, role }));
  }
}

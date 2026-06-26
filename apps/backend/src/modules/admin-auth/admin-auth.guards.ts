import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminRole } from '@packages/shared';
import { AdminAuthService } from './admin-auth.service';

export const ADMIN_ROLES_KEY = 'adminRoles';

export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ADMIN_ROLES_KEY, roles);

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly adminAuth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request);
    if (!token) throw new UnauthorizedException('Admin authentication required.');

    const payload = this.adminAuth.verifyToken(token);
    const requiredRoles = Reflect.getMetadata(ADMIN_ROLES_KEY, context.getHandler())
      ?? Reflect.getMetadata(ADMIN_ROLES_KEY, context.getClass());

    if (requiredRoles?.length && !requiredRoles.includes(payload.role)) {
      throw new UnauthorizedException('Insufficient admin privileges.');
    }

    (request as Request & { adminUser?: typeof payload }).adminUser = payload;
    return true;
  }
}

@Injectable()
export class StaffOrAdminGuard implements CanActivate {
  constructor(private readonly adminAuth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request);
    if (!token) throw new UnauthorizedException('Authentication required.');

    const payload = this.adminAuth.verifyToken(token);
    if (!['master', 'admin', 'staff'].includes(payload.role)) {
      throw new UnauthorizedException('Insufficient privileges.');
    }
    (request as Request & { adminUser?: typeof payload }).adminUser = payload;
    return true;
  }
}

function extractBearer(request: Request): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookieToken = (request as Request & { cookies?: Record<string, string> }).cookies?.admin_token;
  if (cookieToken) return cookieToken;
  const rawCookie = request.headers.cookie;
  if (rawCookie) {
    const match = rawCookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('admin_token='));
    if (match) return decodeURIComponent(match.split('=').slice(1).join('='));
  }
  return null;
}

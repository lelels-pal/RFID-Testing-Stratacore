import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { OperatorAuthService, OperatorJwtPayload } from './operator-auth.service';

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly operatorAuth: OperatorAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Operator authentication required.');
    }
    const payload = this.operatorAuth.verifyToken(header.slice(7));
    (request as Request & { operatorUser?: OperatorJwtPayload }).operatorUser = payload;
    return true;
  }
}

export function getOperatorUser(req: Request): OperatorJwtPayload {
  const user = (req as Request & { operatorUser?: OperatorJwtPayload }).operatorUser;
  if (!user) throw new UnauthorizedException('Operator authentication required.');
  return user;
}

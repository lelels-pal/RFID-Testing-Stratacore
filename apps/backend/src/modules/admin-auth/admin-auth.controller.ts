import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';

@Controller('api/v1/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  login(@Body() body: { username?: string; password?: string }) {
    if (!body.username || !body.password) {
      throw new BadRequestException('username and password are required.');
    }
    return this.adminAuth.login(body.username, body.password);
  }
}

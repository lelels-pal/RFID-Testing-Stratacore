import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AdminLoginRequest } from '@packages/shared';
import { AdminAuthService, AdminJwtPayload } from './admin-auth.service';
import { AdminGuard } from './admin-auth.guards';

@Controller('api/v1/auth/admin')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  async login(@Body() body: AdminLoginRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.adminAuth.login(body.username, body.password);
    res.cookie('admin_token', result.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    return result;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('admin_token');
    return { success: true };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  me(@Req() req: Request & { adminUser?: AdminJwtPayload }) {
    const user = req.adminUser!;
    return { user: { username: user.username, role: user.role } };
  }
}

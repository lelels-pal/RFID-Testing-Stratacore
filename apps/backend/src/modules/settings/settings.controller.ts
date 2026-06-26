import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AppSettings } from '@packages/shared';
import { AdminGuard } from '../admin-auth/admin-auth.guards';
import { SettingsService } from './settings.service';

@Controller('api/v1/settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings(): AppSettings {
    return this.settingsService.get();
  }

  @Put()
  @UseGuards(AdminGuard)
  updateSettings(@Body() body: Partial<AppSettings>): AppSettings {
    return this.settingsService.update(body);
  }
}

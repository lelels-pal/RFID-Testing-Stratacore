import { Module } from '@nestjs/common';
import { OperatorAuthService } from './operator-auth.service';
import { OperatorGuard } from './operator-auth.guards';

@Module({
  providers: [OperatorAuthService, OperatorGuard],
  exports: [OperatorAuthService, OperatorGuard],
})
export class OperatorAuthModule {}

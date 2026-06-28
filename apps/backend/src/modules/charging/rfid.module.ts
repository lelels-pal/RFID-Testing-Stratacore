import { Global, Module } from '@nestjs/common';
import { RfidService } from './rfid.service';

@Global()
@Module({
  providers: [RfidService],
  exports: [RfidService],
})
export class RfidModule {}

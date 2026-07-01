import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AcuteConfigService } from './acute-config.service';
import { AcuteClientService } from './acute-client.service';
import { AcuteTestController } from './acute-test.controller';

@Module({
  imports: [
    HttpModule.register({
      timeout: Number(process.env.ACUTE_TIMEOUT_MS ?? 30000),
    }),
  ],
  providers: [AcuteConfigService, AcuteClientService],
  controllers: [AcuteTestController],
  exports: [AcuteConfigService, AcuteClientService],
})
export class AcuteModule {}
import { Module } from '@nestjs/common';
import { AcuteModule } from '../acute/acute.module';
import { ClientAdminController } from './client-admin.controller';
import { ClientReadService } from './client-read.service';

@Module({
  imports: [AcuteModule],
  controllers: [ClientAdminController],
  providers: [ClientReadService],
  exports: [ClientReadService],
})
export class ClientAdminModule {}

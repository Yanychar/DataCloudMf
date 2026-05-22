import { Module } from '@nestjs/common';
import { ClientAdminModule } from '../client-admin/client-admin.module';
import { ReportingAdminController } from './reporting-admin.controller';
import { OpenAiReportingService } from './openai-reporting.service';
import { ReportingAdminService } from './reporting-admin.service';

@Module({
  imports: [ClientAdminModule],
  controllers: [ReportingAdminController],
  providers: [ReportingAdminService, OpenAiReportingService],
})
export class ReportingAdminModule {}

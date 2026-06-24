import { Module } from '@nestjs/common';
import { AcuteModule } from '../acute/acute.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RepositoryModule } from '../repository/repository.module';
import { IngestionController } from './ingestion.controller';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { IngestionSchedulerService } from './ingestion-scheduler.service';

@Module({
  imports: [AcuteModule, RepositoryModule, NotificationsModule],
  providers: [IngestionOrchestratorService, IngestionSchedulerService],
  controllers: [IngestionController],
})
export class IngestionModule {}

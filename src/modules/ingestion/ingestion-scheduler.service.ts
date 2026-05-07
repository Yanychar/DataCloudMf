import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AcuteConfigService } from '../acute/acute-config.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';

@Injectable()
export class IngestionSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(IngestionSchedulerService.name);

  constructor(
    private readonly acuteConfigService: AcuteConfigService,
    private readonly ingestionOrchestratorService: IngestionOrchestratorService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.acuteConfigService.getDataSyncEnabled()) {
      this.logger.warn('Periodic sync is disabled by config.');
      return;
    }

    for (const entityConfig of this.acuteConfigService.getEntityConfigs()) {
      if (!entityConfig.enabled) {
        continue;
      }

      const job = new CronJob(entityConfig.cron, async () => {
        this.logger.log(`Triggered sync for entity ${entityConfig.key}`);
        await this.ingestionOrchestratorService.syncEntity(entityConfig.key);
      });

      this.schedulerRegistry.addCronJob(entityConfig.key, job);
      job.start();
      this.logger.log(`Registered cron for ${entityConfig.key}: ${entityConfig.cron}`);
    }
  }
}

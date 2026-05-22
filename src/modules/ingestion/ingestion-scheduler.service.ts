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
    void this.initializeScheduler();
  }

  private async initializeScheduler(): Promise<void> {
    const recoveredRuns = await this.ingestionOrchestratorService.recoverAbandonedRuns();
    if (recoveredRuns > 0) {
      this.logger.warn(`Recovered ${recoveredRuns} unfinished sync run(s) after process restart.`);
    }

    if (!this.acuteConfigService.getDataSyncEnabled()) {
      this.logger.warn('Periodic sync is disabled by config.');
      return;
    }

    for (const entityConfig of this.acuteConfigService.getEntityConfigs()) {
      if (!entityConfig.enabled || entityConfig.scheduled === false || !entityConfig.cron) {
        continue;
      }

      const job = new CronJob(entityConfig.cron, async () => {
        this.logger.log(`Triggered raw sync for entity ${entityConfig.key}`);
        try {
          await this.ingestionOrchestratorService.syncRawEntity(entityConfig.key);
        } catch (error) {
          this.logger.error(
            `Scheduled raw sync failed for entity ${entityConfig.key}: ${(error as Error).message}`,
          );
        }
      });

      this.schedulerRegistry.addCronJob(entityConfig.key, job);
      job.start();
      this.logger.log(`Registered cron for ${entityConfig.key}: ${entityConfig.cron}`);
    }
  }
}

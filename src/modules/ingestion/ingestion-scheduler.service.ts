import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AcuteConfigService } from '../acute/acute-config.service';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';

@Injectable()
export class IngestionSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(IngestionSchedulerService.name);
  private readonly rawJobNames = new Set<string>();
  private readonly stageJobName = 'stage-daily';

  constructor(
    private readonly acuteConfigService: AcuteConfigService,
    private readonly ingestionOrchestratorService: IngestionOrchestratorService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    void this.initializeScheduler();
  }

  getSchedulerStatus() {
    const rawJobs = Array.from(this.rawJobNames)
      .map((jobName) => this.schedulerRegistry.doesExist('cron', jobName) ? this.schedulerRegistry.getCronJob(jobName) : null)
      .filter((job): job is CronJob => Boolean(job))
      .map((job) => ({
        name: job.name,
        scheduled: job.isActive,
        nextRunAt: job.nextDate().toJSDate().toISOString(),
      }));

    const hasStageJob = this.schedulerRegistry.doesExist('cron', this.stageJobName);
    const stageJob = hasStageJob ? this.schedulerRegistry.getCronJob(this.stageJobName) : null;

    return {
      rawEnabled: this.acuteConfigService.getDataSyncEnabled(),
      stageEnabled: this.acuteConfigService.getDataStageEnabled(),
      stageDailyCron: this.acuteConfigService.getStageDailyCron(),
      rawJobs,
      stageJob: stageJob
        ? {
            name: this.stageJobName,
            scheduled: stageJob.isActive,
            nextRunAt: stageJob.nextDate().toJSDate().toISOString(),
          }
        : null,
    };
  }

  private async initializeScheduler(): Promise<void> {
    const recoveredRuns = await this.ingestionOrchestratorService.recoverAbandonedRuns();
    if (recoveredRuns > 0) {
      this.logger.warn(`Recovered ${recoveredRuns} unfinished sync run(s) after process restart.`);
    }

    if (!this.acuteConfigService.getDataSyncEnabled()) {
      this.logger.warn('Periodic sync is disabled by config.');
    } else {
      for (const entityConfig of this.acuteConfigService.getEntityConfigs()) {
        if (!entityConfig.enabled || entityConfig.scheduled === false || !entityConfig.cron) {
          continue;
        }

        const job = new CronJob(entityConfig.cron, async () => {
          this.logger.log(`Triggered raw sync for entity ${entityConfig.key}`);
          try {
            await this.ingestionOrchestratorService.syncRawEntity(entityConfig.key, 'scheduled');
          } catch (error) {
            const errorMessage = (error as Error).message;
            this.logger.error(
              `Scheduled raw sync failed for entity ${entityConfig.key}: ${errorMessage}`,
            );
          }
        });

        this.schedulerRegistry.addCronJob(entityConfig.key, job);
        this.rawJobNames.add(entityConfig.key);
        job.start();
        this.logger.log(`Registered cron for ${entityConfig.key}: ${entityConfig.cron}`);
      }
    }

    if (!this.acuteConfigService.getDataStageEnabled()) {
      this.logger.warn('Periodic stage sync is disabled by config.');
      return;
    }

    const stageCron = this.acuteConfigService.getStageDailyCron();
    const stageJob = new CronJob(stageCron, async () => {
      this.logger.log('Triggered daily stage sync sweep');
      for (const entityConfig of this.acuteConfigService.getEntityConfigs()) {
        if (!entityConfig.enabled || !entityConfig.importedFields?.targetTable) {
          continue;
        }

        try {
          const hasActiveStageRun = await this.ingestionOrchestratorService.hasActiveStageRun(
            entityConfig.key,
          );
          if (hasActiveStageRun) {
            continue;
          }

          const waitResult = await this.ingestionOrchestratorService.waitForRawRunToFinish(
            entityConfig.key,
          );
          if (!waitResult.ready) {
            this.logger.warn(
              `Skipping scheduled stage sync for ${entityConfig.key} because raw sync is still running after waiting ${waitResult.waitedMs}ms.`,
            );
            continue;
          }

          const stageResult = await this.ingestionOrchestratorService.stageEntity(
            entityConfig.key,
            'scheduled',
          );
          if (stageResult.skipped) {
            this.logger.log(
              `Scheduled stage sync skipped for ${entityConfig.key}: ${stageResult.reason}`,
            );
          } else if ((stageResult.failedCount ?? 0) > 0) {
            const errorMessage = `${stageResult.failedCount} repository record(s) failed staging for ${entityConfig.key}.`;
            this.logger.error(
              `Scheduled stage sync failed for entity ${entityConfig.key}: ${errorMessage}`,
            );
          }
        } catch (error) {
          const errorMessage = (error as Error).message;
          this.logger.error(
            `Scheduled stage sync failed for entity ${entityConfig.key}: ${errorMessage}`,
          );
        }
      }
    });

    this.schedulerRegistry.addCronJob(this.stageJobName, stageJob);
    stageJob.start();
    this.logger.log(`Registered global daily stage cron: ${stageCron}`);
  }
}

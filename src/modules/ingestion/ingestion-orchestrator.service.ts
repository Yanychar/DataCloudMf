import { Injectable, Logger } from '@nestjs/common';
import { SyncMode } from '@prisma/client';
import { AcuteClientService } from '../acute/acute-client.service';
import { AcuteConfigService } from '../acute/acute-config.service';
import { RepositoryService } from '../repository/repository.service';

@Injectable()
export class IngestionOrchestratorService {
  private readonly logger = new Logger(IngestionOrchestratorService.name);

  constructor(
    private readonly acuteConfigService: AcuteConfigService,
    private readonly acuteClientService: AcuteClientService,
    private readonly repositoryService: RepositoryService,
  ) {}

  async syncEntity(entityKey: string) {
    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    const mode = entityConfig.mode as SyncMode;
    const existingState = await this.repositoryService.getEntityState(entityKey);

    await this.repositoryService.markRunStarted(entityKey);
    const run = await this.repositoryService.createRun(entityKey, mode);

    try {
      const result = await this.acuteClientService.fetchEntity(
        entityConfig,
        mode === 'incremental' ? existingState?.lastSuccessfulSyncAt ?? undefined : undefined,
      );

      const upsertedCount = await this.repositoryService.upsertRecords(entityConfig, result.records);

      await this.repositoryService.markRunCompleted(entityKey, mode);
      await this.repositoryService.completeRun(
        run.id,
        'success',
        result.records.length,
        upsertedCount,
      );

      return {
        entityKey,
        mode,
        fetchedCount: result.records.length,
        upsertedCount,
        requestedAt: result.requestedAt,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Failed syncing ${entityKey}: ${message}`);

      await this.repositoryService.completeRun(run.id, 'failed', 0, 0, message);

      throw error;
    }
  }

  getEntityConfigs() {
    return this.acuteConfigService.getEntityConfigs();
  }
}

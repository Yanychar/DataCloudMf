import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncMode } from '@prisma/client';
import { AcuteClientService } from '../acute/acute-client.service';
import { AcuteConfigService } from '../acute/acute-config.service';
import { AcuteEntityConfig } from '../acute/acute.types';
import { RepositoryService } from '../repository/repository.service';

@Injectable()
export class IngestionOrchestratorService {
  private readonly logger = new Logger(IngestionOrchestratorService.name);
  private readonly maxWindowAttempts = 3;
  private readonly retryDelayMs = 5_000;
  private readonly stageMaxAttempts = 3;
  private readonly stageRetryDelayMs = 1_000;
  private readonly stageBatchSize = 250;

  constructor(
    private readonly acuteConfigService: AcuteConfigService,
    private readonly acuteClientService: AcuteClientService,
    private readonly repositoryService: RepositoryService,
  ) {}

  async syncEntity(entityKey: string) {
    const rawResult = await this.syncRawEntity(entityKey);
    if (rawResult.skipped) {
      return {
        entityKey,
        flowType: 'full',
        raw: rawResult,
        stage: [],
      };
    }

    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    const stageTargets = [entityKey, ...(entityConfig.derivedEntityKeys ?? [])];
    const stageResults = [];

    for (const stageEntityKey of stageTargets) {
      stageResults.push(await this.stageEntity(stageEntityKey));
    }

    return {
      entityKey,
      flowType: 'full',
      raw: rawResult,
      stage: stageResults,
    };
  }

  async syncRawEntity(entityKey: string) {
    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    if (entityConfig.sourceOwnedBy) {
      return {
        entityKey,
        flowType: 'raw',
        mode: entityConfig.mode as SyncMode,
        skipped: true,
        reason: `source_owned_by:${entityConfig.sourceOwnedBy}`,
      };
    }

    return this.runRawSync(entityConfig);
  }

  async stageEntity(entityKey: string) {
    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    return this.runStageSync(entityConfig);
  }

  getEntityConfigs() {
    return this.acuteConfigService.getEntityConfigs();
  }

  async recoverAbandonedRuns(): Promise<number> {
    return this.repositoryService.recoverAbandonedRuns();
  }

  private async runRawSync(entityConfig: AcuteEntityConfig) {
    const entityKey = entityConfig.key;
    const mode = entityConfig.mode as SyncMode;
    if (!entityConfig.enabled) {
      return {
        entityKey,
        flowType: 'raw',
        mode,
        skipped: true,
        reason: 'disabled',
      };
    }

    const hasActiveRun = await this.repositoryService.hasActiveRun(entityKey);

    if (hasActiveRun) {
      return {
        entityKey,
        flowType: 'raw',
        mode,
        skipped: true,
        reason: 'already_running',
      };
    }

    const existingState = await this.repositoryService.getEntityState(entityKey);
    await this.repositoryService.markRunStarted(entityKey);

    const runContext: Record<string, unknown> = {
      entityKey,
      flowType: 'raw',
      strategy: entityConfig.readStrategy ?? 'single',
      initialCursor: entityConfig.initialCursor ?? null,
      lastSuccessfulCursorBeforeRun: existingState?.lastSuccessfulSyncAt?.toISOString() ?? null,
      quarantinedWindows: [],
    };
    const run = await this.repositoryService.createRun(entityKey, mode, 'raw', runContext);

    try {
      const result =
        entityConfig.readStrategy === 'date_window'
          ? await this.syncDateWindowEntity(
              entityConfig,
              mode,
              run.id,
              runContext,
              existingState?.lastSuccessfulSyncAt ?? undefined,
            )
          : await this.syncSingleRequestEntity(
              entityConfig,
              mode,
              existingState?.lastSuccessfulSyncAt ?? undefined,
              run.id,
              runContext,
            );

      await this.repositoryService.markRunCompleted(entityKey, mode, result.lastSuccessfulSyncAt);
      await this.repositoryService.completeRun(
        run.id,
        'success',
        result.fetchedCount,
        result.upsertedCount,
        result.quarantinedWindowCount > 0
          ? `${result.quarantinedWindowCount} window(s) were quarantined and skipped during this raw run.`
          : undefined,
        result.syncContext,
      );

      return {
        entityKey,
        flowType: 'raw',
        mode,
        fetchedCount: result.fetchedCount,
        upsertedCount: result.upsertedCount,
        requestedAt: result.requestedAt,
        lastSuccessfulSyncAt: result.lastSuccessfulSyncAt?.toISOString(),
        quarantinedWindowCount: result.quarantinedWindowCount,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Failed raw sync for ${entityKey}: ${message}`);

      await this.repositoryService.completeRun(run.id, 'failed', 0, 0, message, {
        ...runContext,
        failure: {
          message,
          failedAt: new Date().toISOString(),
        },
      });

      throw error;
    }
  }

  private async runStageSync(entityConfig: AcuteEntityConfig) {
    const entityKey = entityConfig.key;
    const mode = entityConfig.mode as SyncMode;
    if (!entityConfig.enabled) {
      return {
        entityKey,
        flowType: 'stage',
        mode,
        skipped: true,
        reason: 'disabled',
      };
    }

    const hasActiveRun = await this.repositoryService.hasActiveRun(entityKey);

    if (hasActiveRun) {
      return {
        entityKey,
        flowType: 'stage',
        mode,
        skipped: true,
        reason: 'already_running',
      };
    }

    if (!this.repositoryService.hasStagingConfig(entityConfig)) {
      return {
        entityKey,
        flowType: 'stage',
        mode,
        skipped: true,
        reason: 'no_staging_config',
      };
    }

    const pendingBeforeRun = await this.repositoryService.countPendingStageRecords(entityKey);
    const runContext: Record<string, unknown> = {
      entityKey,
      flowType: 'stage',
      pendingBeforeRun,
      batchSize: this.stageBatchSize,
      maxAttemptsPerRecord: this.stageMaxAttempts,
      failures: [],
    };
    const run = await this.repositoryService.createRun(entityKey, mode, 'stage', runContext);

    let cursorId: string | undefined;
    let processedCount = 0;
    let stagedCount = 0;
    const failures: Array<{ externalId: string; errorMessage: string }> = [];

    while (true) {
      const batch = await this.repositoryService.getPendingStageRecords(
        entityKey,
        this.stageBatchSize,
        cursorId,
      );

      if (!batch.length) {
        break;
      }

      cursorId = batch[batch.length - 1].id;

      for (const repositoryRecord of batch) {
        processedCount += 1;
        try {
          await this.stageRecordWithRetry(entityConfig, repositoryRecord);
          stagedCount += 1;
        } catch (error) {
          const errorMessage = (error as Error).message;
          failures.push({
            externalId: repositoryRecord.externalId,
            errorMessage,
          });
          await this.repositoryService.markRepositoryRecordStageFailed(
            repositoryRecord.id,
            errorMessage,
          );
        }
      }

      await this.repositoryService.updateRunContext(run.id, {
        ...runContext,
        cursorId,
        processedCount,
        stagedCount,
        failedCount: failures.length,
        failures,
      });
    }

    const pendingAfterRun = await this.repositoryService.countPendingStageRecords(entityKey);
    const syncContext = {
      ...runContext,
      cursorId,
      processedCount,
      stagedCount,
      failedCount: failures.length,
      failures,
      pendingAfterRun,
    };
    const status = failures.length > 0 ? 'failed' : 'success';
    const message =
      failures.length > 0
        ? `${failures.length} repository record(s) failed staging for ${entityKey}.`
        : undefined;

    await this.repositoryService.completeRun(
      run.id,
      status,
      processedCount,
      stagedCount,
      message,
      syncContext,
    );

    return {
      entityKey,
      flowType: 'stage',
      mode,
      processedCount,
      stagedCount,
      failedCount: failures.length,
      pendingAfterRun,
      failures,
    };
  }

  private async syncSingleRequestEntity(
    entityConfig: AcuteEntityConfig,
    mode: SyncMode,
    lastSuccessfulSyncAt?: Date,
    runId?: string,
    runContext: Record<string, unknown> = {},
  ) {
    if (runId) {
      await this.repositoryService.updateRunContext(runId, {
        ...runContext,
        requestType: 'single',
        currentRequest: {
          startedAt: new Date().toISOString(),
        },
      });
    }

    let result;

    try {
      result = await this.acuteClientService.fetchEntity(
        entityConfig,
        mode === 'incremental' ? lastSuccessfulSyncAt : undefined,
      );
    } catch (error) {
      if (runId) {
        await this.repositoryService.updateRunContext(runId, {
          ...runContext,
          requestType: 'single',
          currentRequest: {
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            status: 'failed',
            errorMessage: (error as Error).message,
          },
        });
      }

      throw error;
    }

    const upsertedCount = await this.repositoryService.upsertRawRecords(entityConfig, result.records);
    const derivedEntityCounts = await this.upsertDerivedEntities(entityConfig, result.records);
    const completedAt = new Date().toISOString();

    return {
      fetchedCount: result.records.length,
      upsertedCount: upsertedCount + derivedEntityCounts.totalUpsertedCount,
      requestedAt: result.requestedAt,
      lastSuccessfulSyncAt: new Date(),
      quarantinedWindowCount: 0,
      syncContext: {
        ...runContext,
        requestType: 'single',
        currentRequest: {
          startedAt: result.requestedAt,
          finishedAt: completedAt,
          status: 'success',
          fetchedCount: result.records.length,
          upsertedCount,
        },
        derivedEntityCounts: derivedEntityCounts.byEntity,
      },
    };
  }

  private async syncDateWindowEntity(
    entityConfig: AcuteEntityConfig,
    mode: SyncMode,
    runId: string,
    runContext: Record<string, unknown>,
    lastSuccessfulSyncAt?: Date,
  ) {
    const rangeFromParam = entityConfig.rangeFromParam;
    const rangeToParam = entityConfig.rangeToParam;
    const initialCursor = entityConfig.initialCursor;

    if (!rangeFromParam || !rangeToParam || !initialCursor) {
      throw new Error(`Entity "${entityConfig.key}" is missing date-window configuration.`);
    }

    let windowFrom = lastSuccessfulSyncAt ?? new Date(initialCursor);
    if (Number.isNaN(windowFrom.getTime())) {
      throw new Error(`Entity "${entityConfig.key}" has invalid initialCursor: ${initialCursor}`);
    }

    let fetchedCount = 0;
    let upsertedCount = 0;
    let lastRequestedAt = new Date().toISOString();
    let lastCompletedWindowEnd = lastSuccessfulSyncAt;
    let quarantinedWindowCount = 0;
    const now = new Date();
    let syncContext: Record<string, unknown> = {
      ...runContext,
      requestType: 'date_window',
      windowUnit: entityConfig.rangeWindowUnit ?? null,
      windowSize: entityConfig.rangeWindowSize ?? null,
      lastCompletedWindow: null,
      lastAttemptedWindow: null,
    };

    while (true) {
      const plannedWindowSize = entityConfig.rangeWindowSize ?? 1;
      const plannedWindowTo = this.addWindow(windowFrom, entityConfig, plannedWindowSize);
      if (plannedWindowTo.getTime() > now.getTime()) {
        this.logger.log(
          `Stopping ${entityConfig.key} raw sync before incomplete window ${windowFrom.toISOString()} -> ${plannedWindowTo.toISOString()} because window end is after now (${now.toISOString()})`,
        );
        break;
      }

      this.logger.log(
        `Syncing ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${plannedWindowTo.toISOString()} (initialWindowSize=${plannedWindowSize} ${entityConfig.rangeWindowUnit ?? 'month'})`,
      );

      syncContext = {
        ...syncContext,
        lastAttemptedWindow: {
          from: windowFrom.toISOString(),
          to: plannedWindowTo.toISOString(),
          status: 'in_progress',
          startedAt: new Date().toISOString(),
        },
      };
      await this.repositoryService.updateRunContext(runId, syncContext);

      const windowAttemptResult = await this.fetchWindowWithRetry(
        entityConfig,
        mode,
        lastSuccessfulSyncAt,
        rangeFromParam,
        rangeToParam,
        windowFrom,
        plannedWindowTo,
        runId,
        syncContext,
      );
      const effectiveWindowTo = windowAttemptResult.windowTo;
      const effectiveWindowSize = windowAttemptResult.windowSize;

      if (windowAttemptResult.status === 'quarantined') {
        quarantinedWindowCount += 1;
        lastCompletedWindowEnd = effectiveWindowTo;
        await this.repositoryService.markSyncProgress(entityConfig.key, mode, effectiveWindowTo);
        syncContext = {
          ...syncContext,
          quarantinedWindows: [
            ...(((syncContext.quarantinedWindows as Record<string, unknown>[] | undefined) ?? [])),
            {
              from: windowFrom.toISOString(),
              to: effectiveWindowTo.toISOString(),
              quarantinedAt: new Date().toISOString(),
              windowSize: effectiveWindowSize,
              errorMessage: windowAttemptResult.error.message,
            },
          ],
          lastAttemptedWindow: {
            from: windowFrom.toISOString(),
            to: effectiveWindowTo.toISOString(),
            status: 'quarantined',
            finishedAt: new Date().toISOString(),
            windowSize: effectiveWindowSize,
            errorMessage: windowAttemptResult.error.message,
          },
          cumulativeFetched: fetchedCount,
          cumulativeUpserted: upsertedCount,
          quarantinedWindowCount,
        };
        await this.repositoryService.updateRunContext(runId, syncContext);

        this.logger.warn(
          `Quarantined ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${effectiveWindowTo.toISOString()} after ${this.maxWindowAttempts} failed attempts. Continuing with the next window.`,
        );

        windowFrom = effectiveWindowTo;
        continue;
      }

      const result = windowAttemptResult.result;

      const currentUpsertedCount = await this.repositoryService.upsertRawRecords(entityConfig, result.records);
      const derivedEntityCounts = await this.upsertDerivedEntities(entityConfig, result.records);
      fetchedCount += result.records.length;
      upsertedCount += currentUpsertedCount + derivedEntityCounts.totalUpsertedCount;
      lastRequestedAt = result.requestedAt;
      lastCompletedWindowEnd = effectiveWindowTo;
      await this.repositoryService.markSyncProgress(entityConfig.key, mode, effectiveWindowTo);
      syncContext = {
        ...syncContext,
        lastAttemptedWindow: {
          from: windowFrom.toISOString(),
          to: effectiveWindowTo.toISOString(),
          status: 'success',
          startedAt:
            ((syncContext.lastAttemptedWindow as Record<string, unknown> | undefined)?.startedAt as string | undefined) ??
            result.requestedAt,
          finishedAt: new Date().toISOString(),
          windowSize: effectiveWindowSize,
          fetchedCount: result.records.length,
          upsertedCount: currentUpsertedCount,
          derivedEntityCounts: derivedEntityCounts.byEntity,
        },
        lastCompletedWindow: {
          from: windowFrom.toISOString(),
          to: effectiveWindowTo.toISOString(),
          completedAt: new Date().toISOString(),
          windowSize: effectiveWindowSize,
          fetchedCount: result.records.length,
          upsertedCount: currentUpsertedCount,
          derivedEntityCounts: derivedEntityCounts.byEntity,
        },
        cumulativeFetched: fetchedCount,
        cumulativeUpserted: upsertedCount,
        quarantinedWindowCount,
      };
      await this.repositoryService.updateRunContext(runId, syncContext);

      this.logger.log(
        `Completed ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${effectiveWindowTo.toISOString()} | windowSize=${effectiveWindowSize} ${entityConfig.rangeWindowUnit ?? 'month'} | fetched=${result.records.length} | rawUpserted=${currentUpsertedCount} | derivedRawUpserted=${derivedEntityCounts.totalUpsertedCount} | cumulativeFetched=${fetchedCount} | cumulativeUpserted=${upsertedCount}`,
      );

      windowFrom = effectiveWindowTo;
    }

    this.logger.log(
      `Finished ${entityConfig.key} raw date-window sync | totalFetched=${fetchedCount} | totalUpserted=${upsertedCount} | quarantinedWindowCount=${quarantinedWindowCount} | lastCompletedWindowEnd=${lastCompletedWindowEnd?.toISOString() ?? 'none'}`,
    );

    return {
      fetchedCount,
      upsertedCount,
      requestedAt: lastRequestedAt,
      lastSuccessfulSyncAt: lastCompletedWindowEnd ?? new Date(initialCursor),
      syncContext,
      quarantinedWindowCount,
    };
  }

  private addWindow(
    windowFrom: Date,
    entityConfig: AcuteEntityConfig,
    windowSize?: number,
  ): Date {
    const size = windowSize ?? entityConfig.rangeWindowSize ?? 1;
    const next = new Date(windowFrom);

    if (entityConfig.rangeWindowUnit === 'month') {
      next.setMonth(next.getMonth() + size);
      return next;
    }

    if (entityConfig.rangeWindowUnit === 'day') {
      next.setDate(next.getDate() + size);
      return next;
    }

    throw new Error(`Unsupported rangeWindowUnit for entity "${entityConfig.key}"`);
  }

  private formatSyncDate(
    value: Date,
    entityConfig: AcuteEntityConfig,
  ): string {
    if (entityConfig.rangeDateFormat === 'date') {
      return value.toISOString().slice(0, 10);
    }

    return value.toISOString().slice(0, 19);
  }

  private async fetchWindowWithRetry(
    entityConfig: AcuteEntityConfig,
    mode: SyncMode,
    lastSuccessfulSyncAt: Date | undefined,
    rangeFromParam: string,
    rangeToParam: string,
    windowFrom: Date,
    plannedWindowTo: Date,
    runId: string,
    syncContext: Record<string, unknown>,
  ) {
    let lastError: Error | undefined;
    const retryWindowSizes = entityConfig.rangeRetryWindowSizes ?? [];

    for (let attempt = 1; attempt <= this.maxWindowAttempts; attempt += 1) {
      const effectiveWindowSize =
        attempt === 1
          ? entityConfig.rangeWindowSize ?? 1
          : retryWindowSizes[attempt - 2] ?? entityConfig.rangeWindowSize ?? 1;
      const windowTo =
        attempt === 1
          ? plannedWindowTo
          : this.addWindow(windowFrom, entityConfig, effectiveWindowSize);
      const attemptStartedAt = new Date().toISOString();
      this.logger.log(
        `Attempt ${attempt}/${this.maxWindowAttempts} for ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${windowTo.toISOString()} (windowSize=${effectiveWindowSize} ${entityConfig.rangeWindowUnit ?? 'month'})`,
      );
      const attemptContext = {
        ...syncContext,
        lastAttemptedWindow: {
          from: windowFrom.toISOString(),
          to: windowTo.toISOString(),
          status: 'in_progress',
          startedAt:
            ((syncContext.lastAttemptedWindow as Record<string, unknown> | undefined)?.startedAt as string | undefined) ??
            attemptStartedAt,
          attempt,
          maxAttempts: this.maxWindowAttempts,
          windowSize: effectiveWindowSize,
        },
      };
      await this.repositoryService.updateRunContext(runId, attemptContext);

      try {
        const result = await this.acuteClientService.fetchEntity(
          entityConfig,
          mode === 'incremental' ? lastSuccessfulSyncAt : undefined,
          {
            [rangeFromParam]: this.formatSyncDate(windowFrom, entityConfig),
            [rangeToParam]: this.formatSyncDate(windowTo, entityConfig),
          },
        );

        if (attempt > 1) {
          this.logger.log(
            `Recovered ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${windowTo.toISOString()} on attempt ${attempt}/${this.maxWindowAttempts}`,
          );
        }

        return {
          result,
          windowTo,
          windowSize: effectiveWindowSize,
        };
      } catch (error) {
        lastError = error as Error;
        const retryable = this.acuteClientService.isRetryableError(error);
        const hasMoreAttempts = attempt < this.maxWindowAttempts;

        const failedContext = {
          ...syncContext,
          lastAttemptedWindow: {
            from: windowFrom.toISOString(),
            to: windowTo.toISOString(),
            status: retryable && hasMoreAttempts ? 'retrying' : 'failed',
            startedAt:
              ((syncContext.lastAttemptedWindow as Record<string, unknown> | undefined)?.startedAt as string | undefined) ??
              attemptStartedAt,
            finishedAt: new Date().toISOString(),
            attempt,
            maxAttempts: this.maxWindowAttempts,
            windowSize: effectiveWindowSize,
            errorMessage: (error as Error).message,
          },
          failure:
            retryable && hasMoreAttempts
              ? undefined
              : {
                  message: (error as Error).message,
                  failedAt: new Date().toISOString(),
                },
        };
        await this.repositoryService.updateRunContext(runId, failedContext);

        if (!(retryable && hasMoreAttempts)) {
          return {
            status: 'quarantined' as const,
            error: error as Error,
            windowTo,
            windowSize: effectiveWindowSize,
          };
        }

        const retryDetails = this.acuteClientService.getRetryableErrorDetails(error);
        this.logger.warn(
          `Retryable Acute error detected for ${entityConfig.key} raw window ${windowFrom.toISOString()} -> ${windowTo.toISOString()} | acuteCode=${String(
            retryDetails.acuteCode ?? 'unknown',
          )} | acuteStatus=${String(retryDetails.acuteStatus ?? 'unknown')} | nextAttempt=${
            attempt + 1
          }/${this.maxWindowAttempts} | nextWindowSize=${
            retryWindowSizes[attempt - 1] ?? entityConfig.rangeWindowSize ?? 1
          } ${entityConfig.rangeWindowUnit ?? 'month'} | delayMs=${this.retryDelayMs} | message=${(error as Error).message}`,
        );
        await this.sleep(this.retryDelayMs);
      }
    }

    return {
      status: 'quarantined' as const,
      error: lastError ?? new Error('Unknown window fetch error'),
      windowTo: plannedWindowTo,
      windowSize: entityConfig.rangeWindowSize ?? 1,
    };
  }

  private async stageRecordWithRetry(
    entityConfig: AcuteEntityConfig,
    repositoryRecord: {
      id: string;
      externalId: string;
      payload: Prisma.JsonValue;
      sourceUpdatedAt: Date | null;
      checksum: string | null;
    },
  ) {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.stageMaxAttempts; attempt += 1) {
      try {
        if (attempt > 1) {
          this.logger.log(
            `Retrying staging for ${entityConfig.key}/${repositoryRecord.externalId} on attempt ${attempt}/${this.stageMaxAttempts}`,
          );
        }

        await this.repositoryService.stageRepositoryRecord(entityConfig, repositoryRecord);
        await this.repositoryService.markRepositoryRecordStaged(
          repositoryRecord.id,
          repositoryRecord.checksum,
        );
        return;
      } catch (error) {
        lastError = error as Error;

        if (attempt >= this.stageMaxAttempts) {
          this.logger.error(
            `Failed staging ${entityConfig.key}/${repositoryRecord.externalId} after ${this.stageMaxAttempts} attempts: ${(error as Error).message}`,
          );
          break;
        }

        this.logger.warn(
          `Retryable staging failure for ${entityConfig.key}/${repositoryRecord.externalId} | nextAttempt=${attempt + 1}/${this.stageMaxAttempts} | delayMs=${this.stageRetryDelayMs} | message=${(error as Error).message}`,
        );
        await this.sleep(this.stageRetryDelayMs);
      }
    }

    throw lastError ?? new Error(`Unknown staging error for ${entityConfig.key}/${repositoryRecord.externalId}`);
  }

  private async sleep(delayMs: number) {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private async upsertDerivedEntities(
    entityConfig: AcuteEntityConfig,
    parentRecords: Record<string, unknown>[],
  ) {
    const derivedEntityKeys = entityConfig.derivedEntityKeys ?? [];

    if (!derivedEntityKeys.length) {
      return {
        totalUpsertedCount: 0,
        byEntity: {} as Record<string, { fetchedCount: number; upsertedCount: number }>,
      };
    }

    let totalUpsertedCount = 0;
    const byEntity: Record<string, { fetchedCount: number; upsertedCount: number }> = {};

    for (const childEntityKey of derivedEntityKeys) {
      const childConfig = this.acuteConfigService.getEntityConfigOrThrow(childEntityKey);
      const childRecords = this.acuteClientService.extractConfiguredChildRecords(
        parentRecords,
        childConfig,
      );
      const childUpsertedCount = await this.repositoryService.upsertRawRecords(
        childConfig,
        childRecords,
      );

      totalUpsertedCount += childUpsertedCount;
      byEntity[childEntityKey] = {
        fetchedCount: childRecords.length,
        upsertedCount: childUpsertedCount,
      };
    }

    return {
      totalUpsertedCount,
      byEntity,
    };
  }
}

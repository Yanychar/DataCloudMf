import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncMode } from '@prisma/client';
import { AcuteClientService } from '../acute/acute-client.service';
import { AcuteConfigService } from '../acute/acute-config.service';
import { AcuteEntityConfig } from '../acute/acute.types';
import { TelegramNotifierService } from '../notifications/telegram-notifier.service';
import { RepositoryService } from '../repository/repository.service';
import { RecoverRawFromDateDto } from './dto/recover-raw-from-date.dto';
import { RecoverRawWindowDto } from './dto/recover-raw-window.dto';

type SyncTrigger = 'scheduled' | 'manual';

interface InvoiceEventHydrationFailure {
  invoiceId: string;
  invoiceDate?: string;
  message: string;
}

interface InvoiceEventHydrationSummary {
  invoicesByIdRequests: number;
  invoicesByIdEventsRecovered: number;
  missingEventsAfterFallback: InvoiceEventHydrationFailure[];
}

interface InvoiceEventHydrationResult {
  records: Record<string, unknown>[];
  summary: InvoiceEventHydrationSummary;
}

@Injectable()
export class IngestionOrchestratorService {
  private readonly logger = new Logger(IngestionOrchestratorService.name);
  private readonly maxWindowAttempts = 3;
  private readonly retryDelayMs = 5_000;
  private readonly stageMaxAttempts = 3;
  private readonly stageRetryDelayMs = 1_000;
  private readonly stageBatchSize = 250;
  private readonly stageWaitForRawTimeoutMs = 30 * 60 * 1000;
  private readonly stageWaitForRawPollMs = 15_000;

  constructor(
    private readonly acuteConfigService: AcuteConfigService,
    private readonly acuteClientService: AcuteClientService,
    private readonly repositoryService: RepositoryService,
    private readonly telegramNotifierService: TelegramNotifierService,
  ) {}

  async syncEntity(entityKey: string, trigger: SyncTrigger = 'manual') {
    const rawResult = await this.syncRawEntity(entityKey, trigger);
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
      stageResults.push(await this.stageEntity(stageEntityKey, trigger));
    }

    return {
      entityKey,
      flowType: 'full',
      raw: rawResult,
      stage: stageResults,
    };
  }

  async syncRawEntity(entityKey: string, trigger: SyncTrigger = 'manual') {
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

    return this.runRawSync(entityConfig, trigger);
  }

  async recoverRawWindow(entityKey: string, dto: RecoverRawWindowDto) {
    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);

    if (entityConfig.sourceOwnedBy) {
      return {
        entityKey,
        flowType: 'raw',
        skipped: true,
        reason: `source_owned_by:${entityConfig.sourceOwnedBy}`,
      };
    }

    if (entityConfig.readStrategy !== 'date_window') {
      throw new BadRequestException(`Entity "${entityKey}" does not use date-window raw sync.`);
    }

    if (!entityConfig.rangeFromParam || !entityConfig.rangeToParam) {
      throw new BadRequestException(`Entity "${entityKey}" is missing date-window parameters.`);
    }

    const windowFrom = this.parseWindowBoundary(dto.from, 'from');
    const windowTo = this.parseWindowBoundary(dto.to, 'to');
    if (windowTo.getTime() < windowFrom.getTime()) {
      throw new BadRequestException('"to" must not be earlier than "from".');
    }

    return this.runRawWindowRecovery(entityConfig, windowFrom, windowTo, dto.note, {
      showEvents: dto.showEvents,
      timeoutMs: dto.timeoutMs,
    });
  }

  async recoverRawFromDate(entityKey: string, dto: RecoverRawFromDateDto) {
    if (entityKey !== 'invoice') {
      throw new BadRequestException('Day-by-day recovery from date is supported for invoice only.');
    }

    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    const firstDay = this.parseDateOnlyBoundary(dto.from, 'from');
    const today = this.todayUtcDateOnly();

    if (firstDay.getTime() > today.getTime()) {
      throw new BadRequestException('"from" must not be later than today.');
    }

    const days = [];
    for (
      let currentDay = new Date(firstDay);
      currentDay.getTime() <= today.getTime();
      currentDay = this.addDays(currentDay, 1)
    ) {
      const date = this.formatDateOnly(currentDay);
      try {
        const result = await this.runRawWindowRecovery(
          entityConfig,
          currentDay,
          currentDay,
          dto.note ?? `Recover invoice raw data for ${date}`,
          { timeoutMs: dto.timeoutMs },
        );
        days.push({
          date,
          status: result.skipped ? 'skipped' : 'success',
          result,
        });
      } catch (error) {
        days.push({
          date,
          status: 'failed',
          errorMessage: (error as Error).message,
        });
      }
    }

    const succeededCount = days.filter((day) => day.status === 'success').length;
    const failedCount = days.filter((day) => day.status === 'failed').length;
    const skippedCount = days.filter((day) => day.status === 'skipped').length;

    return {
      entityKey,
      flowType: 'raw',
      recovery: true,
      strategy: 'daily_from_date',
      from: this.formatDateOnly(firstDay),
      to: this.formatDateOnly(today),
      totalDays: days.length,
      succeededCount,
      failedCount,
      skippedCount,
      days,
    };
  }

  async stageEntity(entityKey: string, trigger: SyncTrigger = 'manual') {
    const entityConfig = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    return this.runStageSync(entityConfig, trigger);
  }

  getEntityConfigs() {
    return this.acuteConfigService.getEntityConfigs();
  }

  async getEnumLookupValues(entityKey: string, fieldKey: string) {
    return this.repositoryService.getEnumLookupValues(entityKey, fieldKey);
  }

  async recoverAbandonedRuns(): Promise<number> {
    return this.repositoryService.recoverAbandonedRuns();
  }

  async hasActiveStageRun(entityKey: string): Promise<boolean> {
    return this.repositoryService.hasActiveRun(entityKey, 'stage');
  }

  async waitForRawRunToFinish(entityKey: string): Promise<
    | { ready: true }
    | { ready: false; reason: 'raw_still_running'; waitedMs: number }
  > {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.stageWaitForRawTimeoutMs) {
      const rawRun = await this.repositoryService.getActiveRun(entityKey, 'raw');
      if (!rawRun) {
        return { ready: true };
      }

      await this.delay(this.stageWaitForRawPollMs);
    }

    return {
      ready: false,
      reason: 'raw_still_running',
      waitedMs: Date.now() - startedAt,
    };
  }

  private async runRawSync(entityConfig: AcuteEntityConfig, trigger: SyncTrigger) {
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
              trigger,
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
      await this.telegramNotifierService.notifySyncFailure({
        entityKey,
        flowType: 'raw',
        trigger,
        errorMessage: message,
      });

      throw error;
    }
  }

  private async runRawWindowRecovery(
    entityConfig: AcuteEntityConfig,
    windowFrom: Date,
    windowTo: Date,
    note?: string,
    options: { showEvents?: boolean; timeoutMs?: number } = {},
  ) {
    const entityKey = entityConfig.key;
    const mode = entityConfig.mode as SyncMode;
    const rangeFromParam = entityConfig.rangeFromParam;
    const rangeToParam = entityConfig.rangeToParam;

    if (!rangeFromParam || !rangeToParam) {
      throw new BadRequestException(`Entity "${entityKey}" is missing date-window parameters.`);
    }

    if (!entityConfig.enabled) {
      return {
        entityKey,
        flowType: 'raw',
        mode,
        skipped: true,
        reason: 'disabled',
      };
    }

    const hasActiveRawRun = await this.repositoryService.hasActiveRun(entityKey, 'raw');
    if (hasActiveRawRun) {
      return {
        entityKey,
        flowType: 'raw',
        mode,
        skipped: true,
        reason: 'already_running',
      };
    }

    await this.repositoryService.markRunStarted(entityKey);
    const runContext: Record<string, unknown> = {
      entityKey,
      flowType: 'raw',
      strategy: 'manual_window_recovery',
      requestedWindow: {
        from: windowFrom.toISOString(),
        to: windowTo.toISOString(),
      },
      note: note ?? null,
      recoveryOverrides: {
        showEvents: options.showEvents ?? null,
        timeoutMs: options.timeoutMs ?? null,
      },
      doesNotAdvanceCursor: true,
    };
    const run = await this.repositoryService.createRun(entityKey, mode, 'raw', runContext);

    let runFinished = false;
    try {
      const windowResult = await this.fetchExactWindowWithRetry(
        entityConfig,
        rangeFromParam,
        rangeToParam,
        windowFrom,
        windowTo,
        run.id,
        runContext,
        options,
      );

      if (windowResult.status === 'failed') {
        const failureContext = {
          ...runContext,
          status: 'failed',
          failedWindow: {
            from: windowFrom.toISOString(),
            to: windowTo.toISOString(),
            attemptCount: windowResult.attemptCount,
            errorMessage: windowResult.error.message,
          },
        };
        await this.repositoryService.completeRun(
          run.id,
          'failed',
          0,
          0,
          windowResult.error.message,
          failureContext,
        );
        runFinished = true;
        if (windowResult.attemptCount >= this.maxWindowAttempts) {
          await this.telegramNotifierService.notifyRawWindowFailure({
            entityKey,
            trigger: 'manual',
            windowFrom: windowFrom.toISOString(),
            windowTo: windowTo.toISOString(),
            attemptCount: windowResult.attemptCount,
            windowSize: this.calculateRecoveryWindowSize(windowFrom, windowTo, entityConfig),
            windowUnit: entityConfig.rangeWindowUnit,
            errorMessage: windowResult.error.message,
          });
        }

        throw windowResult.error;
      }

      const hydrated = await this.hydrateInvoiceEventsIfNeeded(
        entityConfig,
        windowResult.result.records,
        options.timeoutMs,
      );
      const rawUpsertedCount = await this.repositoryService.upsertRawRecords(
        entityConfig,
        hydrated.records,
      );
      const derivedEntityCounts = await this.upsertDerivedEntities(
        entityConfig,
        hydrated.records,
      );
      const upsertedCount = rawUpsertedCount + derivedEntityCounts.totalUpsertedCount;
      const syncContext = {
        ...runContext,
        status: 'success',
        recoveredWindow: {
          from: windowFrom.toISOString(),
          to: windowTo.toISOString(),
          attemptCount: windowResult.attemptCount,
          fetchedCount: windowResult.result.records.length,
          rawUpsertedCount,
          invoiceEventHydration: hydrated.summary,
          derivedEntityCounts: derivedEntityCounts.byEntity,
          recoveredAt: new Date().toISOString(),
        },
      };

      await this.repositoryService.completeRun(
        run.id,
        'success',
        windowResult.result.records.length,
        upsertedCount,
        undefined,
        syncContext,
      );
      runFinished = true;

      return {
        entityKey,
        flowType: 'raw',
        mode,
        recovery: true,
        windowFrom: windowFrom.toISOString(),
        windowTo: windowTo.toISOString(),
        fetchedCount: windowResult.result.records.length,
        rawUpsertedCount,
        upsertedCount,
        derivedEntityCounts: derivedEntityCounts.byEntity,
        invoiceEventHydration: hydrated.summary,
        attemptCount: windowResult.attemptCount,
        cursorAdvanced: false,
      };
    } catch (error) {
      if (!runFinished) {
        const errorMessage = (error as Error).message;
        await this.repositoryService.completeRun(run.id, 'failed', 0, 0, errorMessage, {
          ...runContext,
          status: 'failed',
          failure: {
            message: errorMessage,
            failedAt: new Date().toISOString(),
          },
        });
      }

      throw error;
    }
  }

  private async runStageSync(entityConfig: AcuteEntityConfig, trigger: SyncTrigger) {
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

    const hasActiveStageRun = await this.repositoryService.hasActiveRun(entityKey, 'stage');
    if (hasActiveStageRun) {
      return {
        entityKey,
        flowType: 'stage',
        mode,
        skipped: true,
        reason: 'already_running',
      };
    }

    const hasActiveRawRun = await this.repositoryService.hasActiveRun(entityKey, 'raw');
    if (hasActiveRawRun) {
      return {
        entityKey,
        flowType: 'stage',
        mode,
        skipped: true,
        reason: 'raw_running',
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
    const seededLookupValueCount = await this.repositoryService.syncKnownEnumLookupValues(entityConfig);
    const runContext: Record<string, unknown> = {
      entityKey,
      flowType: 'stage',
      pendingBeforeRun,
      seededLookupValueCount,
      batchSize: this.stageBatchSize,
      maxAttemptsPerRecord: this.stageMaxAttempts,
      failures: [],
    };
    const run = await this.repositoryService.createRun(entityKey, mode, 'stage', runContext);

    let cursorId: string | undefined;
    let processedCount = 0;
    let stagedCount = 0;
    const failures: Array<{ externalId: string; errorMessage: string }> = [];

    try {
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

      if (message) {
        await this.telegramNotifierService.notifySyncFailure({
          entityKey,
          flowType: 'stage',
          trigger,
          errorMessage: message,
        });
      }

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
    } catch (error) {
      const errorMessage = (error as Error).message;

      await this.repositoryService.completeRun(
        run.id,
        'failed',
        processedCount,
        stagedCount,
        errorMessage,
        {
          ...runContext,
          cursorId,
          processedCount,
          stagedCount,
          failedCount: failures.length,
          failures,
          failure: {
            message: errorMessage,
            failedAt: new Date().toISOString(),
          },
        },
      );
      await this.telegramNotifierService.notifySyncFailure({
        entityKey,
        flowType: 'stage',
        trigger,
        errorMessage,
      });

      throw error;
    }
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

    const hydrated = await this.hydrateInvoiceEventsIfNeeded(entityConfig, result.records);
    const upsertedCount = await this.repositoryService.upsertRawRecords(entityConfig, hydrated.records);
    const derivedEntityCounts = await this.upsertDerivedEntities(entityConfig, hydrated.records);
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
    trigger: SyncTrigger = 'manual',
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
        if (windowAttemptResult.attemptCount >= this.maxWindowAttempts) {
          await this.telegramNotifierService.notifyRawWindowFailure({
            entityKey: entityConfig.key,
            trigger,
            windowFrom: windowFrom.toISOString(),
            windowTo: effectiveWindowTo.toISOString(),
            attemptCount: windowAttemptResult.attemptCount,
            windowSize: effectiveWindowSize,
            windowUnit: entityConfig.rangeWindowUnit,
            errorMessage: windowAttemptResult.error.message,
          });
        }

        windowFrom = effectiveWindowTo;
        continue;
      }

      const result = windowAttemptResult.result;

      const hydrated = await this.hydrateInvoiceEventsIfNeeded(entityConfig, result.records);
      const currentUpsertedCount = await this.repositoryService.upsertRawRecords(entityConfig, hydrated.records);
      const derivedEntityCounts = await this.upsertDerivedEntities(entityConfig, hydrated.records);
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
          invoiceEventHydration: hydrated.summary,
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
    options: { showEvents?: boolean; timeoutMs?: number } = {},
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
            attemptCount: attempt,
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
      attemptCount: this.maxWindowAttempts,
    };
  }

  private async fetchExactWindowWithRetry(
    entityConfig: AcuteEntityConfig,
    rangeFromParam: string,
    rangeToParam: string,
    windowFrom: Date,
    windowTo: Date,
    runId: string,
    syncContext: Record<string, unknown>,
    options: { showEvents?: boolean; timeoutMs?: number } = {},
  ) {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxWindowAttempts; attempt += 1) {
      const attemptStartedAt = new Date().toISOString();
      const attemptContext = {
        ...syncContext,
        lastAttemptedWindow: {
          from: windowFrom.toISOString(),
          to: windowTo.toISOString(),
          status: 'in_progress',
          startedAt: attemptStartedAt,
          attempt,
          maxAttempts: this.maxWindowAttempts,
          exactWindowRecovery: true,
        },
      };
      await this.repositoryService.updateRunContext(runId, attemptContext);

      try {
        const extraParams: Record<string, unknown> = {
          [rangeFromParam]: this.formatSyncDate(windowFrom, entityConfig),
          [rangeToParam]: this.formatSyncDate(windowTo, entityConfig),
        };
        if (typeof options.showEvents === 'boolean') {
          extraParams.showEvents = options.showEvents;
        }

        const result = await this.acuteClientService.fetchEntity(
          entityConfig,
          undefined,
          extraParams,
          { timeoutMs: options.timeoutMs },
        );

        return {
          status: 'success' as const,
          result,
          attemptCount: attempt,
        };
      } catch (error) {
        lastError = error as Error;
        const hasMoreAttempts = attempt < this.maxWindowAttempts;
        await this.repositoryService.updateRunContext(runId, {
          ...syncContext,
          lastAttemptedWindow: {
            from: windowFrom.toISOString(),
            to: windowTo.toISOString(),
            status: hasMoreAttempts ? 'retrying' : 'failed',
            startedAt: attemptStartedAt,
            finishedAt: new Date().toISOString(),
            attempt,
            maxAttempts: this.maxWindowAttempts,
            exactWindowRecovery: true,
            errorMessage: lastError.message,
          },
          failure: hasMoreAttempts
            ? undefined
            : {
                message: lastError.message,
                failedAt: new Date().toISOString(),
              },
        });

        if (!hasMoreAttempts) {
          return {
            status: 'failed' as const,
            error: lastError,
            attemptCount: attempt,
          };
        }

        this.logger.warn(
          `Manual raw window recovery failed for ${entityConfig.key} ${windowFrom.toISOString()} -> ${windowTo.toISOString()} | nextAttempt=${
            attempt + 1
          }/${this.maxWindowAttempts} | delayMs=${this.retryDelayMs} | message=${lastError.message}`,
        );
        await this.sleep(this.retryDelayMs);
      }
    }

    return {
      status: 'failed' as const,
      error: lastError ?? new Error('Unknown manual raw window recovery error'),
      attemptCount: this.maxWindowAttempts,
    };
  }

  private parseWindowBoundary(value: string, fieldName: 'from' | 'to'): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`"${fieldName}" must be a valid date or datetime.`);
    }

    return parsed;
  }

  private calculateRecoveryWindowSize(
    windowFrom: Date,
    windowTo: Date,
    entityConfig: AcuteEntityConfig,
  ): number {
    const diffMs = windowTo.getTime() - windowFrom.getTime();

    if (entityConfig.rangeWindowUnit === 'day') {
      return diffMs / (24 * 60 * 60 * 1000);
    }

    if (entityConfig.rangeWindowUnit === 'month') {
      return (
        (windowTo.getUTCFullYear() - windowFrom.getUTCFullYear()) * 12 +
        (windowTo.getUTCMonth() - windowFrom.getUTCMonth())
      );
    }

    return diffMs;
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

  private async hydrateInvoiceEventsIfNeeded(
    entityConfig: AcuteEntityConfig,
    records: Record<string, unknown>[],
    timeoutMs?: number,
  ): Promise<InvoiceEventHydrationResult> {
    const summary: InvoiceEventHydrationSummary = {
      invoicesByIdRequests: 0,
      invoicesByIdEventsRecovered: 0,
      missingEventsAfterFallback: [],
    };

    if (entityConfig.key !== 'invoice') {
      return { records, summary };
    }

    const hydratedRecords: Record<string, unknown>[] = [];

    for (const record of records) {
      if (this.hasNonNullEvents(record)) {
        hydratedRecords.push(record);
        continue;
      }

      const invoiceId = this.extractInvoiceId(record);
      if (!invoiceId) {
        hydratedRecords.push(record);
        continue;
      }

      const invoiceDate = this.extractInvoiceDate(record);

      try {
        summary.invoicesByIdRequests += 1;
        const invoiceResponse = await this.acuteClientService.request(`/invoices/${invoiceId}`, undefined, {
          timeoutMs,
        });
        const invoiceEvents = this.isObject(invoiceResponse) ? invoiceResponse.events : undefined;

        if (invoiceEvents !== null && typeof invoiceEvents !== 'undefined') {
          summary.invoicesByIdEventsRecovered += 1;
          hydratedRecords.push({
            ...record,
            events: invoiceEvents,
          });
          continue;
        }
      } catch (error) {
        await this.recordInvoiceEventsMissing(summary, {
          invoiceId,
          invoiceDate,
          message: `Invoices invoice-by-id event hydration failed: ${(error as Error).message}`,
        });
        hydratedRecords.push(record);
        continue;
      }

      await this.recordInvoiceEventsMissing(summary, {
        invoiceId,
        invoiceDate,
        message: 'Events are null after Invoices invoice-by-id fallback request.',
      });
      hydratedRecords.push(record);
    }

    return {
      records: hydratedRecords,
      summary,
    };
  }

  private async recordInvoiceEventsMissing(
    summary: InvoiceEventHydrationSummary,
    failure: InvoiceEventHydrationFailure,
  ): Promise<void> {
    summary.missingEventsAfterFallback.push(failure);
    this.logger.error(
      `Invoice events missing after fallback | invoiceId=${failure.invoiceId} | invoiceDate=${
        failure.invoiceDate ?? 'unknown'
      } | message=${failure.message}`,
    );
    await this.telegramNotifierService.notifyInvoiceEventsMissing({
      invoiceId: failure.invoiceId,
      invoiceDate: failure.invoiceDate,
      errorMessage: failure.message,
    });
  }

  private hasNonNullEvents(record: Record<string, unknown>): boolean {
    return 'events' in record && record.events !== null && typeof record.events !== 'undefined';
  }

  private extractInvoiceId(record: Record<string, unknown>): string | undefined {
    const value = record.invoiceId;
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }

    return undefined;
  }

  private extractInvoiceDate(record: Record<string, unknown>): string | undefined {
    const value = record.invoiceDate;
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }

    return undefined;
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseDateOnlyBoundary(value: string, fieldName: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new BadRequestException(`"${fieldName}" must use YYYY-MM-DD format.`);
    }

    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid "${fieldName}" date.`);
    }

    return parsed;
  }

  private todayUtcDateOnly(): Date {
    return this.parseDateOnlyBoundary(new Date().toISOString().slice(0, 10), 'today');
  }

  private addDays(value: Date, days: number): Date {
    const next = new Date(value);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  private formatDateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
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

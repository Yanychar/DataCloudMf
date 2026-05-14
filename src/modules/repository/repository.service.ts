import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, SyncMode } from '@prisma/client';
import { AcuteEntityConfig } from '../acute/acute.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RepositoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getEntityState(entityKey: string) {
    return this.prisma.entitySyncState.findUnique({
      where: { entityKey },
    });
  }

  async markRunStarted(entityKey: string) {
    return this.prisma.entitySyncState.upsert({
      where: { entityKey },
      create: {
        entityKey,
        lastRunStartedAt: new Date(),
      },
      update: {
        lastRunStartedAt: new Date(),
      },
    });
  }

  async markSyncProgress(entityKey: string, mode: SyncMode, lastSuccessfulSyncAt: Date) {
    return this.prisma.entitySyncState.upsert({
      where: { entityKey },
      create: {
        entityKey,
        lastSuccessfulSyncAt,
        lastSyncMode: mode,
      },
      update: {
        lastSuccessfulSyncAt,
        lastSyncMode: mode,
      },
    });
  }

  async markRunCompleted(entityKey: string, mode: SyncMode, lastSuccessfulSyncAt?: Date) {
    const completedAt = new Date();
    const syncCursor = lastSuccessfulSyncAt ?? completedAt;

    return this.prisma.entitySyncState.upsert({
      where: { entityKey },
      create: {
        entityKey,
        lastRunCompletedAt: completedAt,
        lastSuccessfulSyncAt: syncCursor,
        lastSyncMode: mode,
      },
      update: {
        lastRunCompletedAt: completedAt,
        lastSuccessfulSyncAt: syncCursor,
        lastSyncMode: mode,
      },
    });
  }

  async createRun(entityKey: string, mode: SyncMode) {
    return this.prisma.syncRun.create({
      data: {
        entityKey,
        mode,
        status: 'success',
        startedAt: new Date(),
        syncContext: {
          strategy: 'single',
        } as Prisma.InputJsonValue,
      } as Prisma.SyncRunCreateInput,
    });
  }

  async updateRunContext(runId: string, syncContext: Record<string, unknown>) {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        syncContext: syncContext as Prisma.InputJsonValue,
      } as Prisma.SyncRunUpdateInput,
    });
  }

  async completeRun(
    runId: string,
    status: 'success' | 'failed',
    fetchedCount: number,
    upsertedCount: number,
    message?: string,
    syncContext?: Record<string, unknown>,
  ) {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        status,
        fetchedCount,
        upsertedCount,
        message,
        finishedAt: new Date(),
        syncContext: syncContext as Prisma.InputJsonValue | undefined,
      } as Prisma.SyncRunUpdateInput,
    });
  }

  async upsertRecords(
    entityConfig: AcuteEntityConfig,
    records: Record<string, unknown>[],
  ): Promise<number> {
    let upsertedCount = 0;

    for (const record of records) {
      const externalId = this.extractExternalId(record, entityConfig);
      if (!externalId) {
        continue;
      }

      const sourceUpdatedAt = this.extractDate(record, entityConfig.sourceUpdatedAtField);
      const sanitizedRecord = this.sanitizeRecord(record, entityConfig);
      const checksum = createHash('sha256').update(JSON.stringify(sanitizedRecord)).digest('hex');

      await this.prisma.repositoryRecord.upsert({
        where: {
          entityType_externalId: {
            entityType: entityConfig.key,
            externalId,
          },
        },
        create: {
          entityType: entityConfig.key,
          externalId,
          payload: sanitizedRecord as Prisma.InputJsonValue,
          sourceUpdatedAt,
          checksum,
        },
        update: {
          payload: sanitizedRecord as Prisma.InputJsonValue,
          sourceUpdatedAt,
          checksum,
        },
      });

      upsertedCount += 1;
    }

    return upsertedCount;
  }

  private sanitizeRecord(
    record: Record<string, unknown>,
    entityConfig: AcuteEntityConfig,
  ): Record<string, unknown> {
    if (!entityConfig.importedFields?.length) {
      return record;
    }

    const sanitized: Record<string, unknown> = {};

    for (const field of entityConfig.importedFields) {
      const sourcePath = field.sourcePath ?? field.key;
      const value = this.getValueByPath(record, sourcePath);

      if (typeof value !== 'undefined') {
        sanitized[field.key] = value;
      }
    }

    return sanitized;
  }

  private extractExternalId(
    record: Record<string, unknown>,
    entityConfig: AcuteEntityConfig,
  ): string | undefined {
    if (entityConfig.compositeExternalIdFields?.length) {
      const values = entityConfig.compositeExternalIdFields.map((field) => record[field]);
      if (values.every((value) => typeof value === 'string' || typeof value === 'number')) {
        return values.map(String).join('::');
      }
    }

    if (entityConfig.externalIdField) {
      const explicitValue = record[entityConfig.externalIdField];
      if (typeof explicitValue === 'string' || typeof explicitValue === 'number') {
        return String(explicitValue);
      }
    }

    const candidates = ['id', 'ID', 'uuid', 'externalId'];

    for (const key of candidates) {
      const value = record[key];
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    return undefined;
  }

  private extractDate(
    record: Record<string, unknown>,
    fieldName?: string,
  ): Date | undefined {
    if (!fieldName) {
      return undefined;
    }

    const value = record[fieldName];
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private getValueByPath(
    record: Record<string, unknown>,
    path: string,
  ): unknown {
    return path.split('.').reduce<unknown>((current, segment) => {
      if (typeof current === 'object' && current !== null && !Array.isArray(current)) {
        return (current as Record<string, unknown>)[segment];
      }

      return undefined;
    }, record);
  }
}

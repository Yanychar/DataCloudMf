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

  async markRunCompleted(entityKey: string, mode: SyncMode) {
    return this.prisma.entitySyncState.upsert({
      where: { entityKey },
      create: {
        entityKey,
        lastRunCompletedAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        lastSyncMode: mode,
      },
      update: {
        lastRunCompletedAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
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
      },
    });
  }

  async completeRun(
    runId: string,
    status: 'success' | 'failed',
    fetchedCount: number,
    upsertedCount: number,
    message?: string,
  ) {
    return this.prisma.syncRun.update({
      where: { id: runId },
      data: {
        status,
        fetchedCount,
        upsertedCount,
        message,
        finishedAt: new Date(),
      },
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
      const checksum = createHash('sha256').update(JSON.stringify(record)).digest('hex');

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
          payload: record as Prisma.InputJsonValue,
          sourceUpdatedAt,
          checksum,
        },
        update: {
          payload: record as Prisma.InputJsonValue,
          sourceUpdatedAt,
          checksum,
        },
      });

      upsertedCount += 1;
    }

    return upsertedCount;
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
}

import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, SyncMode } from '@prisma/client';
import { AcuteEntityConfig, ImportedFieldConfig } from '../acute/acute.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RepositoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getEntityState(entityKey: string) {
    return this.prisma.entitySyncState.findUnique({
      where: { entityKey },
    });
  }

  async hasActiveRun(entityKey: string): Promise<boolean> {
    const activeRun = await this.prisma.syncRun.findFirst({
      where: {
        entityKey,
        finishedAt: null,
      },
      select: {
        id: true,
      },
      orderBy: {
        startedAt: 'desc',
      },
    });

    return Boolean(activeRun);
  }

  async recoverAbandonedRuns(): Promise<number> {
    const result = await this.prisma.syncRun.updateMany({
      where: {
        finishedAt: null,
      },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        message: 'Recovered after process restart',
      },
    });

    return result.count;
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

      await this.upsertStructuredRecord(
        entityConfig,
        externalId,
        sanitizedRecord,
        sourceUpdatedAt,
        checksum,
      );

      upsertedCount += 1;
    }

    return upsertedCount;
  }

  private sanitizeRecord(
    record: Record<string, unknown>,
    entityConfig: AcuteEntityConfig,
  ): Record<string, unknown> {
    if (!entityConfig.importedFields) {
      return record;
    }

    if (entityConfig.importedFields.restrictPayloadToListedFields === false) {
      return record;
    }

    const fields = entityConfig.importedFields.fields;

    if (!fields.length) {
      return record;
    }

    const sanitized: Record<string, unknown> = {};

    for (const field of fields) {
      const sourcePath = field.sourcePath ?? field.key;
      const value = this.getValueByPath(record, sourcePath);

      if (typeof value !== 'undefined') {
        sanitized[field.key] = value;
      }
    }

    return sanitized;
  }

  private async upsertStructuredRecord(
    entityConfig: AcuteEntityConfig,
    externalId: string,
    sanitizedRecord: Record<string, unknown>,
    sourceUpdatedAt: Date | undefined,
    checksum: string,
  ) {
    const importedConfig = entityConfig.importedFields;
    if (!importedConfig) {
      return;
    }

    if (importedConfig.targetTable !== 'stg_client') {
      return;
    }

    const split = this.splitStructuredRecord(importedConfig.fields, sanitizedRecord);

    await this.prisma.stgClient.upsert({
      where: { externalId },
      create: {
        externalId,
        clientUri: this.asNullableString(split.columnData.client),
        birthDate: this.asNullableDate(split.columnData.birthDate),
        gender: this.asNullableString(split.columnData.gender),
        homeUnit: this.asNullableString(split.columnData.homeUnit),
        city: this.asNullableString(split.columnData.city),
        municipality: this.asNullableString(split.columnData.municipality),
        municipalityCode: this.asNullableString(split.columnData.municipalityCode),
        countryId: this.asNullableString(split.columnData.countryId),
        clientType: this.asNullableString(split.columnData.clientType),
        endDate: this.asNullableDate(split.columnData.endDate),
        deathDate: this.asNullableDate(split.columnData.deathDate),
        latestSaveDate: this.asNullableDate(split.columnData.latestSaveDate),
        latestSavePersonnelId: this.asNullableNumber(split.columnData.latestSavePersonnelId),
        extraData: split.jsonData as Prisma.InputJsonValue,
        sourceUpdatedAt,
        checksum,
      },
      update: {
        clientUri: this.asNullableString(split.columnData.client),
        birthDate: this.asNullableDate(split.columnData.birthDate),
        gender: this.asNullableString(split.columnData.gender),
        homeUnit: this.asNullableString(split.columnData.homeUnit),
        city: this.asNullableString(split.columnData.city),
        municipality: this.asNullableString(split.columnData.municipality),
        municipalityCode: this.asNullableString(split.columnData.municipalityCode),
        countryId: this.asNullableString(split.columnData.countryId),
        clientType: this.asNullableString(split.columnData.clientType),
        endDate: this.asNullableDate(split.columnData.endDate),
        deathDate: this.asNullableDate(split.columnData.deathDate),
        latestSaveDate: this.asNullableDate(split.columnData.latestSaveDate),
        latestSavePersonnelId: this.asNullableNumber(split.columnData.latestSavePersonnelId),
        extraData: split.jsonData as Prisma.InputJsonValue,
        sourceUpdatedAt,
        checksum,
      },
    });
  }

  private splitStructuredRecord(
    fields: ImportedFieldConfig[],
    sanitizedRecord: Record<string, unknown>,
  ) {
    const columnData: Record<string, unknown> = {};
    const jsonData: Record<string, unknown> = {};

    for (const field of fields) {
      const value = sanitizedRecord[field.key];
      if (typeof value === 'undefined') {
        continue;
      }

      if (field.isColumn) {
        columnData[field.key] = value;
      } else {
        jsonData[field.key] = value;
      }
    }

    return {
      columnData,
      jsonData,
    };
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

  private asNullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private asNullableNumber(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
  }

  private asNullableDate(value: unknown): Date | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}

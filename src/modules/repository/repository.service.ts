import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, RepositoryRecord, SyncMode } from '@prisma/client';
import {
  AcuteEntityConfig,
  ImportedFieldConfig,
  ImportedFieldPossibleValueConfig,
} from '../acute/acute.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RepositoryService {
  constructor(private readonly prisma: PrismaService) {}

  private get enumLookupDelegate(): {
    upsert: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown>;
  } {
    return (this.prisma as unknown as Record<string, { upsert: (args: unknown) => Promise<unknown>; findMany: (args: unknown) => Promise<unknown> }>)[
      'enumLookup'
    ];
  }

  async getEntityState(entityKey: string) {
    return this.prisma.entitySyncState.findUnique({
      where: { entityKey },
    });
  }

  async hasActiveRun(entityKey: string, flowType?: 'raw' | 'stage'): Promise<boolean> {
    const activeRun = await this.prisma.syncRun.findFirst({
      where: {
        entityKey,
        finishedAt: null,
        ...(flowType ? { flowType } : {}),
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

  async getActiveRun(
    entityKey: string,
    flowType?: 'raw' | 'stage',
  ): Promise<Pick<Prisma.SyncRunGetPayload<{ select: { id: true; flowType: true; startedAt: true } }>, 'id' | 'flowType' | 'startedAt'> | null> {
    return this.prisma.syncRun.findFirst({
      where: {
        entityKey,
        finishedAt: null,
        ...(flowType ? { flowType } : {}),
      },
      select: {
        id: true,
        flowType: true,
        startedAt: true,
      },
      orderBy: {
        startedAt: 'desc',
      },
    });
  }

  hasStagingConfig(entityConfig: AcuteEntityConfig): boolean {
    return Boolean(entityConfig.importedFields?.targetTable);
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

  async createRun(
    entityKey: string,
    mode: SyncMode,
    flowType: 'raw' | 'stage',
    syncContext?: Record<string, unknown>,
  ) {
    return this.prisma.syncRun.create({
      data: {
        entityKey,
        flowType,
        mode,
        status: 'success',
        startedAt: new Date(),
        syncContext: (syncContext ?? {
          strategy: 'single',
        }) as Prisma.InputJsonValue,
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

  async upsertRawRecords(
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
          stagingNeeded: true,
        },
        update: {
          payload: sanitizedRecord as Prisma.InputJsonValue,
          sourceUpdatedAt,
          checksum,
          stagingNeeded: true,
          stageError: null,
        },
      });

      upsertedCount += 1;
    }

    return upsertedCount;
  }

  async getPendingStageRecords(
    entityKey: string,
    take: number,
    cursorId?: string,
  ): Promise<
    Pick<
      RepositoryRecord,
      'id' | 'entityType' | 'externalId' | 'payload' | 'sourceUpdatedAt' | 'checksum' | 'updatedAt'
    >[]
  > {
    const baseQuery = Prisma.sql`
      SELECT
        id,
        entityType,
        externalId,
        payload,
        sourceUpdatedAt,
        checksum,
        updatedAt
      FROM RepositoryRecord FORCE INDEX (RepositoryRecord_entityType_stagingNeeded_id_idx)
      WHERE entityType = ${entityKey}
        AND stagingNeeded = true
    `;

    const cursorClause = cursorId
      ? Prisma.sql`AND id > ${cursorId}`
      : Prisma.empty;

    return this.prisma.$queryRaw<
      Pick<
        RepositoryRecord,
        'id' | 'entityType' | 'externalId' | 'payload' | 'sourceUpdatedAt' | 'checksum' | 'updatedAt'
      >[]
    >(Prisma.sql`
      ${baseQuery}
      ${cursorClause}
      ORDER BY id ASC
      LIMIT ${take}
    `);
  }

  async countPendingStageRecords(entityKey: string): Promise<number> {
    return this.prisma.repositoryRecord.count({
      where: {
        entityType: entityKey,
        stagingNeeded: true,
      },
    });
  }

  async stageRepositoryRecord(
    entityConfig: AcuteEntityConfig,
    repositoryRecord: Pick<
      RepositoryRecord,
      'id' | 'externalId' | 'payload' | 'sourceUpdatedAt' | 'checksum'
    >,
  ): Promise<void> {
    const payload = repositoryRecord.payload;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error(
        `RepositoryRecord ${repositoryRecord.externalId} payload is not a JSON object and cannot be staged.`,
      );
    }

    const importedFields = entityConfig.importedFields;
    if (!importedFields) {
      throw new Error(`Entity "${entityConfig.key}" has no imported-fields staging configuration.`);
    }

    const stagedRecord = this.projectImportedRecord(
      payload as Record<string, unknown>,
      importedFields.fields,
    );

    await this.upsertStructuredRecord(
      entityConfig,
      repositoryRecord.externalId,
      stagedRecord,
      repositoryRecord.sourceUpdatedAt ?? undefined,
      repositoryRecord.checksum ?? createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    );
  }

  async syncKnownEnumLookupValues(entityConfig: AcuteEntityConfig): Promise<number> {
    const fields = entityConfig.importedFields?.fields ?? [];
    let upsertedCount = 0;

    for (const field of fields) {
      const possibleValues = field.possibleValues ?? [];
      for (const value of possibleValues) {
        await this.upsertEnumLookupValue(entityConfig.key, field.key, value);
        upsertedCount += 1;
      }
    }

    return upsertedCount;
  }

  async getEnumLookupValues(entityKey: string, fieldKey: string) {
    return this.enumLookupDelegate.findMany({
      where: {
        entityKey,
        fieldKey,
      },
      orderBy: [{ sortOrder: 'asc' }, { codeInt: 'asc' }],
    });
  }

  async markRepositoryRecordStaged(recordId: string, checksum?: string | null) {
    return this.prisma.repositoryRecord.update({
      where: { id: recordId },
      data: {
        stagingNeeded: false,
        lastStagedAt: new Date(),
        lastStagedChecksum: checksum ?? null,
        stageError: null,
      },
    });
  }

  async markRepositoryRecordStageFailed(recordId: string, errorMessage: string) {
    return this.prisma.repositoryRecord.update({
      where: { id: recordId },
      data: {
        stagingNeeded: true,
        stageError: errorMessage,
      },
    });
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

    return this.projectImportedRecord(record, fields);
  }

  private projectImportedRecord(
    record: Record<string, unknown>,
    fields: ImportedFieldConfig[],
  ): Record<string, unknown> {
    const projected: Record<string, unknown> = {};

    for (const field of fields) {
      const sourcePath = field.sourcePath ?? field.key;
      const value = this.getValueByPath(record, sourcePath);

      if (typeof value !== 'undefined') {
        projected[field.key] = value;
      }
    }

    return projected;
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

    const delegateName = this.getPrismaDelegateName(importedConfig.targetTable);
    const delegate = (this.prisma as unknown as Record<string, { upsert: (args: unknown) => Promise<unknown> }>)[
      delegateName
    ];

    if (!delegate) {
      return;
    }

    await this.ensureEnumLookupValuesForRecord(entityConfig, sanitizedRecord);

    const split = this.splitStructuredRecord(importedConfig.fields, sanitizedRecord);
    const structuredData = this.buildStructuredRecordData(importedConfig.fields, split.columnData);

    await delegate.upsert({
      where: { externalId },
      create: {
        externalId,
        ...structuredData,
        extraData: split.jsonData as Prisma.InputJsonValue,
        sourceUpdatedAt,
        checksum,
      },
      update: {
        ...structuredData,
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

      const targetKey = field.targetColumn ?? field.key;

      if (field.isColumn) {
        columnData[targetKey] = value;
      } else {
        jsonData[field.key] = value;
      }
    }

    return {
      columnData,
      jsonData,
    };
  }

  private async ensureEnumLookupValuesForRecord(
    entityConfig: AcuteEntityConfig,
    sanitizedRecord: Record<string, unknown>,
  ): Promise<void> {
    const fields = entityConfig.importedFields?.fields ?? [];

    for (const field of fields) {
      if (!field.possibleValues?.length) {
        continue;
      }

      const value = sanitizedRecord[field.key];
      const unknownLookupValue = this.buildUnknownLookupValue(value);
      if (!unknownLookupValue) {
        continue;
      }

      const knownValue = field.possibleValues.find((item) =>
        item.codeText ? item.codeText === value : item.codeInt === value,
      );

      await this.upsertEnumLookupValue(
        entityConfig.key,
        field.key,
        knownValue ?? unknownLookupValue,
      );
    }
  }

  private async upsertEnumLookupValue(
    entityKey: string,
    fieldKey: string,
    value: ImportedFieldPossibleValueConfig,
  ): Promise<void> {
    const domainKey = this.buildEnumDomainKey(entityKey, fieldKey);
    const createData = {
      domainKey,
      entityKey,
      fieldKey,
      codeInt: typeof value.codeInt === 'number' ? value.codeInt : null,
      codeText: typeof value.codeText === 'string' ? value.codeText : null,
      codeLabel: value.codeLabel,
      sortOrder: value.sortOrder,
    };
    const updateData = {
      entityKey,
      fieldKey,
      codeLabel: value.codeLabel,
      sortOrder: value.sortOrder ?? null,
    };

    if (typeof value.codeText === 'string') {
      await this.enumLookupDelegate.upsert({
        where: {
          domainKey_codeText: {
            domainKey,
            codeText: value.codeText,
          },
        },
        create: createData,
        update: updateData,
      });
      return;
    }

    if (typeof value.codeInt === 'number') {
      await this.enumLookupDelegate.upsert({
        where: {
          domainKey_codeInt: {
            domainKey,
            codeInt: value.codeInt,
          },
        },
        create: createData,
        update: updateData,
      });
    }
  }

  private buildStructuredRecordData(
    fields: ImportedFieldConfig[],
    columnData: Record<string, unknown>,
  ): Record<string, unknown> {
    const structuredData: Record<string, unknown> = {};

    for (const field of fields) {
      if (!field.isColumn) {
        continue;
      }

      const targetKey = field.targetColumn ?? field.key;
      structuredData[field.key] = this.normalizeStructuredValue(
        columnData[targetKey],
        field.dataType,
      );

      if (targetKey !== field.key) {
        structuredData[targetKey] = structuredData[field.key];
        delete structuredData[field.key];
      }
    }

    return structuredData;
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

  private normalizeStructuredValue(
    value: unknown,
    dataType?: ImportedFieldConfig['dataType'],
  ): unknown {
    if (typeof value === 'undefined') {
      return null;
    }

    switch (dataType) {
      case 'number':
        return typeof value === 'number' ? value : null;
      case 'boolean':
        return typeof value === 'boolean' ? value : null;
      case 'date': {
        if (typeof value !== 'string' && typeof value !== 'number') {
          return null;
        }

        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      case 'array':
      case 'object':
        return value as Prisma.InputJsonValue;
      case 'string':
      default:
        return typeof value === 'string' ? value : null;
    }
  }

  private getPrismaDelegateName(targetTable: string): string {
    return targetTable.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase());
  }

  private buildEnumDomainKey(entityKey: string, fieldKey: string): string {
    return `${entityKey}.${fieldKey}`;
  }

  private buildUnknownLookupValue(value: unknown): ImportedFieldPossibleValueConfig | undefined {
    if (Number.isInteger(value)) {
      return {
        codeInt: Number(value),
        codeLabel: 'unknown',
      };
    }

    if (typeof value === 'string' && value) {
      return {
        codeText: value,
        codeLabel: 'unknown',
      };
    }

    return undefined;
  }
}

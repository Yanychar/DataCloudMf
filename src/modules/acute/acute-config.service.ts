import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AcuteEntityConfig,
  ImportedEntityConfig,
  ImportedFieldConfig,
  ImportedFieldPossibleValueConfig,
  ReadStrategy,
} from './acute.types';

@Injectable()
export class AcuteConfigService {
  constructor(private readonly configService: ConfigService) {}

  getAppEnv(): string {
    return this.configService.get<string>('APP_ENV', 'development');
  }

  getAcuteEnvironment(): 'prod' | 'stage' {
    return this.getAppEnv() === 'production' ? 'prod' : 'stage';
  }

  getBaseUrl(): string {
    return this.configService.get<string>(this.getAcuteEnvVarName('BASE_URL'), '');
  }

  getLogin(): string {
    return this.configService.get<string>(this.getAcuteEnvVarName('LOGIN'), '');
  }

  getPassword(): string {
    return this.configService.get<string>(this.getAcuteEnvVarName('PASSWORD'), '');
  }

  hasBasicAuthCredentials(): boolean {
    return Boolean(this.getLogin() && this.getPassword());
  }

  getTimeoutMs(): number {
    return Number(this.configService.get<string>('ACUTE_TIMEOUT_MS', '30000'));
  }

  getDataSyncEnabled(): boolean {
    return this.configService.get<string>('DATA_SYNC_ENABLED', 'true') === 'true';
  }

  getDataStageEnabled(): boolean {
    return this.configService.get<string>('DATA_STAGE_ENABLED', 'true') === 'true';
  }

  getDefaultCron(): string {
    return this.configService.get<string>('DATA_SYNC_DEFAULT_CRON', '*/30 * * * *');
  }

  getStageDailyCron(): string {
    return this.configService.get<string>('DATA_STAGE_DAILY_CRON', '30 2 * * *');
  }

  getDefaultMode(): 'full' | 'incremental' {
    const value = this.configService.get<string>('DATA_SYNC_DEFAULT_MODE', 'incremental');
    return value === 'full' ? 'full' : 'incremental';
  }

  getEntityConfigs(): AcuteEntityConfig[] {
    const configPath = resolve(
      process.cwd(),
      this.configService.get<string>('DATA_SYNC_ENTITY_CONFIG_PATH', 'config/entities.config.json'),
    );
    const importedFieldsByEntity = this.getImportedFieldsByEntity();

    if (!existsSync(configPath)) {
      throw new Error(`Entity config file not found: ${configPath}`);
    }

    const raw = readFileSync(configPath, 'utf-8');

    try {
      const parsed = JSON.parse(raw) as Partial<AcuteEntityConfig>[];

      return parsed.map((item) => ({
        key: item.key ?? '',
        label: item.label ?? item.key ?? '',
        endpoint: item.endpoint ?? '',
        cron: item.cron ?? this.getDefaultCron(),
        mode: item.mode === 'full' ? 'full' : this.getDefaultMode(),
        enabled: item.enabled ?? true,
        scheduled: item.scheduled ?? true,
        sourceOwnedBy: item.sourceOwnedBy,
        derivedEntityKeys: Array.isArray(item.derivedEntityKeys)
          ? item.derivedEntityKeys.filter((value): value is string => typeof value === 'string')
          : undefined,
        staticParams:
          item.staticParams && typeof item.staticParams === 'object'
            ? (item.staticParams as Record<string, string | number | boolean>)
            : undefined,
        sourceUpdatedAtField: item.sourceUpdatedAtField,
        incrementalQueryParam: item.incrementalQueryParam,
        externalIdField: item.externalIdField,
        compositeExternalIdFields: item.compositeExternalIdFields,
        recordPath: item.recordPath,
        recordContextParentFields: item.recordContextParentFields,
        readStrategy: AcuteConfigService.normalizeReadStrategy(item.readStrategy),
        rangeFromParam: item.rangeFromParam,
        rangeToParam: item.rangeToParam,
        rangeWindowUnit: item.rangeWindowUnit,
        rangeDateFormat: item.rangeDateFormat === 'date' ? 'date' : 'datetime',
        rangeWindowSize: item.rangeWindowSize,
        rangeRetryWindowSizes: Array.isArray(item.rangeRetryWindowSizes)
          ? item.rangeRetryWindowSizes.filter((value): value is number => typeof value === 'number')
          : undefined,
        initialCursor: item.initialCursor,
        importedFields: importedFieldsByEntity[item.key ?? ''],
        notes: item.notes,
      }));
    } catch (error) {
      throw new Error(`Invalid entity config file at ${configPath}: ${(error as Error).message}`);
    }
  }

  getEntityConfigOrThrow(entityKey: string): AcuteEntityConfig {
    const entity = this.getEntityConfigs().find((item) => item.key === entityKey);

    if (!entity) {
      throw new Error(`Entity config not found for key "${entityKey}"`);
    }

    return entity;
  }

  private static normalizeReadStrategy(value: unknown): ReadStrategy {
    return value === 'date_window' ? 'date_window' : 'single';
  }

  private normalizeImportedFields(value: unknown): ImportedEntityConfig | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const targetTable = typeof record.targetTable === 'string' ? record.targetTable : '';
    const restrictPayloadToListedFields = record.restrictPayloadToListedFields !== false;
    const fieldsValue = record.fields;

    if (!Array.isArray(fieldsValue) || !targetTable) {
      return undefined;
    }

    const normalized = fieldsValue
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        key: typeof item.key === 'string' ? item.key : '',
        sourcePath: typeof item.sourcePath === 'string' ? item.sourcePath : undefined,
        targetColumn: typeof item.targetColumn === 'string' ? item.targetColumn : undefined,
        description: typeof item.description === 'string' ? item.description : '',
        dataType: AcuteConfigService.normalizeImportedFieldDataType(item.dataType),
        isColumn: item.isColumn === true,
        filterable: item.filterable === true,
        includeInAiContext: item.includeInAiContext !== false,
        possibleValues: AcuteConfigService.normalizeImportedFieldPossibleValues(item.possibleValues),
      }))
      .filter((item) => item.key && item.description);

    return normalized.length
      ? {
          targetTable,
          restrictPayloadToListedFields,
          fields: normalized,
        }
      : undefined;
  }

  private getImportedFieldsByEntity(): Record<string, ImportedEntityConfig | undefined> {
    const configPath = resolve(
      process.cwd(),
      this.configService.get<string>(
        'DATA_SYNC_IMPORTED_FIELDS_CONFIG_PATH',
        'config/imported-fields.config.json',
      ),
    );

    if (!existsSync(configPath)) {
      return {};
    }

    const raw = readFileSync(configPath, 'utf-8');

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      return Object.fromEntries(
        Object.entries(parsed).map(([entityKey, value]) => [
          entityKey,
          this.normalizeImportedFields(value),
        ]),
      );
    } catch (error) {
      throw new Error(
        `Invalid imported fields config file at ${configPath}: ${(error as Error).message}`,
      );
    }
  }

  private static normalizeImportedFieldDataType(value: unknown): ImportedFieldConfig['dataType'] {
    switch (value) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'date':
      case 'object':
      case 'array':
        return value;
      default:
        return undefined;
    }
  }

  private static normalizeImportedFieldPossibleValues(
    value: unknown,
  ): ImportedFieldPossibleValueConfig[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const normalized = value
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        codeInt: typeof item.codeInt === 'number' ? item.codeInt : undefined,
        codeText: typeof item.codeText === 'string' ? item.codeText : undefined,
        codeLabel: typeof item.codeLabel === 'string' ? item.codeLabel : '',
        sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : undefined,
      }))
      .filter(
        (item) =>
          item.codeLabel &&
          (Number.isInteger(item.codeInt) || Boolean(item.codeText)),
      );

    return normalized.length ? normalized : undefined;
  }

  private getAcuteEnvVarName(suffix: 'BASE_URL' | 'LOGIN' | 'PASSWORD'): string {
    return this.getAcuteEnvironment() === 'prod'
      ? `ACUTE_PROD_${suffix}`
      : `ACUTE_STAGE_${suffix}`;
  }
}

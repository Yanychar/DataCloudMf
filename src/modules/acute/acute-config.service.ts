import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AcuteEntityConfig } from './acute.types';

@Injectable()
export class AcuteConfigService {
  constructor(private readonly configService: ConfigService) {}

  getBaseUrl(): string {
    return this.configService.get<string>('ACUTE_BASE_URL', '');
  }

  getApiKey(): string {
    return this.configService.get<string>('ACUTE_API_KEY', '');
  }

  getTimeoutMs(): number {
    return Number(this.configService.get<string>('ACUTE_TIMEOUT_MS', '30000'));
  }

  getDataSyncEnabled(): boolean {
    return this.configService.get<string>('DATA_SYNC_ENABLED', 'true') === 'true';
  }

  getDefaultCron(): string {
    return this.configService.get<string>('DATA_SYNC_DEFAULT_CRON', '*/30 * * * *');
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
        pageSize: item.pageSize,
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
}

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import { AcuteConfigService } from './acute-config.service';
import { AcuteEntityConfig, AcuteFetchResult } from './acute.types';

@Injectable()
export class AcuteClientService {
  private readonly logger = new Logger(AcuteClientService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly acuteConfigService: AcuteConfigService,
  ) {}

  async ping(): Promise<{ ok: boolean; baseUrl: string }> {
    return {
      ok: Boolean(this.acuteConfigService.getBaseUrl()),
      baseUrl: this.acuteConfigService.getBaseUrl(),
    };
  }

  async request(path: string, params?: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this.acuteConfigService.getBaseUrl();
    const apiKey = this.acuteConfigService.getApiKey();

    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

    this.logger.debug(`Requesting Acute: ${url}`);

    const response = await lastValueFrom(
      this.httpService.get(url, {
        params,
        headers: {
          Authorization: apiKey ? `Bearer ${apiKey}` : undefined,
          Accept: 'application/json',
        },
      }),
    );

    return response.data;
  }

  async fetchEntity(
    entityConfig: AcuteEntityConfig,
    lastSuccessfulSyncAt?: Date,
  ): Promise<AcuteFetchResult> {
    const params: Record<string, unknown> = {
      ...(entityConfig.staticParams ?? {}),
    };

    if (
      entityConfig.mode === 'incremental' &&
      entityConfig.incrementalQueryParam &&
      lastSuccessfulSyncAt
    ) {
      params[entityConfig.incrementalQueryParam] = lastSuccessfulSyncAt.toISOString();
    }

    if (entityConfig.pageSize) {
      params.pageSize = entityConfig.pageSize;
    }

    const data = await this.request(entityConfig.endpoint, params);
    const records = this.normalizeRecords(data, entityConfig);

    return {
      records,
      requestedAt: new Date().toISOString(),
    };
  }

  private normalizeRecords(
    data: unknown,
    entityConfig: AcuteEntityConfig,
  ): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return this.extractRecordPath(data as Record<string, unknown>[], entityConfig);
    }

    if (this.isObject(data)) {
      const objectData = data as Record<string, unknown>;

      if (Array.isArray(objectData.data)) {
        return this.extractRecordPath(objectData.data as Record<string, unknown>[], entityConfig);
      }

      if (Array.isArray(objectData.items)) {
        return this.extractRecordPath(objectData.items as Record<string, unknown>[], entityConfig);
      }

      return this.extractRecordPath([objectData], entityConfig);
    }

    return [];
  }

  private extractRecordPath(
    records: Record<string, unknown>[],
    entityConfig: AcuteEntityConfig,
  ): Record<string, unknown>[] {
    if (!entityConfig.recordPath) {
      return records;
    }

    const nestedRecords: Record<string, unknown>[] = [];

    for (const record of records) {
      const rawNested = record[entityConfig.recordPath];
      if (!Array.isArray(rawNested)) {
        continue;
      }

      for (const nested of rawNested) {
        if (!this.isObject(nested)) {
          continue;
        }

        const parentContext = this.buildParentContext(record, entityConfig.recordContextParentFields);
        nestedRecords.push({
          ...nested,
          ...(Object.keys(parentContext).length > 0 ? { _parentContext: parentContext } : {}),
        });
      }
    }

    return nestedRecords;
  }

  private buildParentContext(
    parent: Record<string, unknown>,
    fields?: string[],
  ): Record<string, unknown> {
    if (!fields?.length) {
      return {};
    }

    return fields.reduce<Record<string, unknown>>((accumulator, field) => {
      if (field in parent) {
        accumulator[field] = parent[field];
      }

      return accumulator;
    }, {});
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

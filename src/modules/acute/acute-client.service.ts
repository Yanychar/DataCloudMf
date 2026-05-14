import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import { BadGatewayException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import { AcuteConfigService } from './acute-config.service';
import { AcuteEntityConfig, AcuteFetchResult, AcuteRequestPreview } from './acute.types';

@Injectable()
export class AcuteClientService {

  private readonly logger = new Logger(AcuteClientService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly acuteConfigService: AcuteConfigService,
  ) {}

  async ping(): Promise<{ ok: boolean; baseUrl: string }> {
    return {
      ok:
        Boolean(this.acuteConfigService.getBaseUrl()) &&
        this.acuteConfigService.hasBasicAuthCredentials(),
      baseUrl: this.acuteConfigService.getBaseUrl(),
    };
  }

  buildRequestPreview(path: string, params?: Record<string, unknown>): AcuteRequestPreview {
    return this.buildRequestPreviewWithOptions({
      path,
      params,
    });
  }

  buildRequestPreviewWithOptions(options: {
    path: string;
    method?: 'GET' | 'POST';
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
    timeoutMs?: number;
  }): AcuteRequestPreview {
    const baseUrl = this.acuteConfigService.getBaseUrl();
    const login = this.acuteConfigService.getStageLogin();
    const password = this.acuteConfigService.getStagePassword();
    const url = options.path.startsWith('http') ? options.path : `${baseUrl}${options.path}`;
    const authHeader =
      login && password
        ? `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`
        : undefined;
    const params = options.params ?? {};

    return {
      method: options.method ?? 'GET',
      url,
      fullUrl: this.buildFullUrl(url, params),
      params,
      body: options.body,
      timeoutMs: options.timeoutMs ?? this.acuteConfigService.getTimeoutMs(),
      headers: {
        Accept: 'application/json',
        Authorization: authHeader ? 'Basic ***' : undefined,
        'Content-Type': options.method === 'POST' ? 'application/json' : undefined,
      },
      auth: login && password
        ? {
            type: 'basic',
            username: login,
          }
        : {
            type: 'none',
          },
    };
  }

  async request(
    path: string,
    params?: Record<string, unknown>,
    options?: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      timeoutMs?: number;
      treatItemNotFoundAsEmpty?: string;
    },
  ): Promise<unknown> {

    // Buid preview object containing everything for the request
    const preview = this.buildRequestPreviewWithOptions({
      path,
      method: options?.method,
      params,
      body: options?.body,
      timeoutMs: options?.timeoutMs,
    });
    // Log data for the request
    this.logRequestPreview('Sending Acute request', preview);

    try {
      // Build request headers
      const headers = {
        Authorization:
          this.acuteConfigService.hasBasicAuthCredentials()
            ? `Basic ${Buffer.from(
                `${this.acuteConfigService.getStageLogin()}:${this.acuteConfigService.getStagePassword()}`,
              ).toString('base64')}`
            : undefined,
        Accept: preview.headers.Accept,
        'Content-Type': preview.headers['Content-Type'],
      };

      // here is making real request
      const response = await lastValueFrom(
        preview.method === 'POST'
          ? this.httpService.post(preview.url, preview.body ?? {}, {
              params: preview.params,
              headers,
              timeout: preview.timeoutMs,
            })
          : this.httpService.get(preview.url, {
              params: preview.params,
              headers,
              timeout: preview.timeoutMs,
            }),
      );

      this.logger.log(
        `Acute response received: ${preview.method} ${preview.url} -> ${response.status}`,
      );

      return response.data;
    } catch (error) {
      if (this.shouldTreatItemNotFoundAsEmpty(error, options?.treatItemNotFoundAsEmpty)) {
        this.logger.log(
          `Acute returned ITEM_NOT_FOUND:${options?.treatItemNotFoundAsEmpty}; treating as empty result set.`,
        );
        return [];
      }

      throw this.mapAcuteError(error, preview.url);
    }
  }

  async fetchEntity(
    entityConfig: AcuteEntityConfig,
    lastSuccessfulSyncAt?: Date,
    extraParams?: Record<string, unknown>,
  ): Promise<AcuteFetchResult> {
    const params = this.buildEntityParams(entityConfig, lastSuccessfulSyncAt, extraParams);
    const data = await this.request(entityConfig.endpoint, params, {
      treatItemNotFoundAsEmpty: entityConfig.label,
    });
    const records = this.normalizeRecords(data, entityConfig);

    return {
      records,
      requestedAt: new Date().toISOString(),
    };
  }

  buildEntityRequestPreview(
    entityConfig: AcuteEntityConfig,
    lastSuccessfulSyncAt?: Date,
    extraParams?: Record<string, unknown>,
  ): AcuteRequestPreview {
    return this.buildRequestPreview(
      entityConfig.endpoint,
      this.buildEntityParams(entityConfig, lastSuccessfulSyncAt, extraParams),
    );
  }

  private buildEntityParams(
    entityConfig: AcuteEntityConfig,
    lastSuccessfulSyncAt?: Date,
    extraParams?: Record<string, unknown>,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      ...(entityConfig.staticParams ?? {}),
      ...(extraParams ?? {}),
    };

    if (
      entityConfig.mode === 'incremental' &&
      entityConfig.incrementalQueryParam &&
      lastSuccessfulSyncAt
    ) {
      params[entityConfig.incrementalQueryParam] = lastSuccessfulSyncAt.toISOString();
    }

    return params;
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

  private shouldTreatItemNotFoundAsEmpty(
    error: unknown,
    itemName?: string,
  ): boolean {
    if (!(error instanceof AxiosError) || !itemName) {
      return false;
    }

    const status = error.response?.status;
    const responseData = this.normalizeErrorPayload(error.response?.data);

    return status === 404 && responseData === `ITEM_NOT_FOUND:${itemName}`;
  }

  isRetryableError(error: unknown): boolean {
    if (!(error instanceof BadGatewayException)) {
      return false;
    }

    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    const acuteCode = 'acuteCode' in response ? response.acuteCode : undefined;
    const acuteStatus = 'acuteStatus' in response ? response.acuteStatus : undefined;

    return (
      acuteCode === 'ECONNABORTED' ||
      acuteCode === 'ECONNRESET' ||
      acuteCode === 'EAI_AGAIN' ||
      acuteCode === 'ERR_BAD_RESPONSE' ||
      acuteStatus === 502 ||
      acuteStatus === 503 ||
      acuteStatus === 504
    );
  }

  getRetryableErrorDetails(error: unknown): { acuteCode?: unknown; acuteStatus?: unknown } {
    if (!(error instanceof BadGatewayException)) {
      return {};
    }

    const response = error.getResponse();
    if (typeof response !== 'object' || response === null) {
      return {};
    }

    return {
      acuteCode: 'acuteCode' in response ? response.acuteCode : undefined,
      acuteStatus: 'acuteStatus' in response ? response.acuteStatus : undefined,
    };
  }

  private mapAcuteError(error: unknown, url: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const responseData = this.normalizeErrorPayload(error.response?.data);

      this.logger.error(
        `Acute request failed for ${url}${status ? ` with status ${status}` : ''}: ${responseData}`,
      );

      if (status === 401 || status === 403) {
        return new UnauthorizedException({
          message: 'Acute authentication failed',
          acuteStatus: status,
          acuteResponse: responseData,
        });
      }

      if (error.code && ['DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code)) {
        return new BadGatewayException({
          message: 'Acute TLS validation failed',
          acuteCode: error.code,
          hint: 'The Acute environment may require custom certificate handling.',
        });
      }

      return new BadGatewayException({
        message: 'Acute request failed',
        acuteStatus: status ?? null,
        acuteCode: error.code ?? null,
        acuteResponse: responseData,
        hint: error.code === 'ECONNABORTED' ? 'Acute request timed out before a response was returned.' : undefined,
      });
    }

    const message = error instanceof Error ? error.message : 'Unknown Acute request error';
    this.logger.error(`Acute request failed for ${url}: ${message}`);

    return new BadGatewayException({
      message: 'Acute request failed',
      acuteResponse: message,
    });
  }

  private normalizeErrorPayload(payload: unknown): string {
    if (typeof payload === 'string') {
      return payload;
    }

    if (payload === undefined || payload === null) {
      return 'No response body';
    }

    try {
      return JSON.stringify(payload);
    } catch {
      return 'Unserializable response body';
    }
  }

  private logRequestPreview(prefix: string, preview: AcuteRequestPreview): void {
    this.logger.log(
      `${prefix}: ${preview.method} ${preview.fullUrl} | params=${JSON.stringify(preview.params)} | body=${
        preview.body ? JSON.stringify(preview.body) : '{}'
      } | timeoutMs=${preview.timeoutMs} | auth=${preview.auth.type}${
        preview.auth.username ? `(${preview.auth.username})` : ''
      }`,
    );
  }

  private buildFullUrl(url: string, params: Record<string, unknown>): string {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          searchParams.append(key, String(item));
        }
        continue;
      }

      searchParams.append(key, String(value));
    }

    const queryString = searchParams.toString();
    return queryString ? `${url}?${queryString}` : url;
  }
}

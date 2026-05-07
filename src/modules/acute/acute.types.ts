export type SyncMode = 'full' | 'incremental';

export interface AcuteEntityConfig {
  key: string;
  label: string;
  endpoint: string;
  cron: string;
  mode: SyncMode;
  enabled: boolean;
  staticParams?: Record<string, string | number | boolean>;
  sourceUpdatedAtField?: string;
  incrementalQueryParam?: string;
  externalIdField?: string;
  compositeExternalIdFields?: string[];
  recordPath?: string;
  recordContextParentFields?: string[];
  pageSize?: number;
  notes?: string;
}

export interface AcuteFetchResult {
  records: Record<string, unknown>[];
  requestedAt: string;
}

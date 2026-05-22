export type SyncMode = 'full' | 'incremental';
export type ReadStrategy = 'single' | 'date_window';
export type ImportedFieldDataType = 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array';

export interface ImportedFieldConfig {
  key: string;
  sourcePath?: string;
  description: string;
  dataType?: ImportedFieldDataType;
  isColumn?: boolean;
  filterable?: boolean;
  includeInAiContext?: boolean;
}

export interface ImportedEntityConfig {
  targetTable: string;
  restrictPayloadToListedFields?: boolean;
  fields: ImportedFieldConfig[];
}

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
  readStrategy?: ReadStrategy;
  rangeFromParam?: string;
  rangeToParam?: string;
  rangeWindowUnit?: 'month' | 'day';
  rangeDateFormat?: 'datetime' | 'date';
  rangeWindowSize?: number;
  rangeRetryWindowSizes?: number[];
  initialCursor?: string;
  importedFields?: ImportedEntityConfig;
  notes?: string;
}

export interface AcuteFetchResult {
  records: Record<string, unknown>[];
  requestedAt: string;
}

export interface AcuteRequestPreview {
  method: 'GET' | 'POST';
  url: string;
  fullUrl: string;
  params: Record<string, unknown>;
  body?: Record<string, unknown>;
  timeoutMs: number;
  headers: {
    Accept: string;
    Authorization?: string;
    'Content-Type'?: string;
  };
  auth: {
    type: 'basic' | 'none';
    username?: string;
  };
}

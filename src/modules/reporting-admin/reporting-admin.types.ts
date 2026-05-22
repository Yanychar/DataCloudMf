export interface ClientReportRunFilters {
  birthDateFrom?: string;
  birthDateTo?: string;
  ageFrom?: number;
  ageTo?: number;
  gender?: string;
  clientType?: string;
  city?: string;
  search?: string;
}

export interface ClientReportRunOptions {
  limit?: number;
  includeRawRows?: boolean;
}

export interface ReportSectionMetricItem {
  label: string;
  value: string | number | boolean | null;
}

export interface ReportSection {
  type: 'metric_list' | 'table' | 'bullet_list';
  title: string;
  items?: ReportSectionMetricItem[];
  columns?: string[];
  rows?: Array<Array<string | number | boolean | null>>;
}

export interface ClientReportResult {
  generator: 'openai_direct' | 'local_fallback';
  note?: string;
  prompt: string;
  summary: string;
  sections: ReportSection[];
  notes?: string[];
  model?: string;
  truncated?: boolean;
  rowCount?: number;
}

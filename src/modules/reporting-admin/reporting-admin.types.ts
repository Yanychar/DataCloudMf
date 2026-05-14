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

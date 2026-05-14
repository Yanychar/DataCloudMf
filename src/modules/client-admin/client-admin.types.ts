export interface ClientListFilters {
  birthDateFrom?: string;
  birthDateTo?: string;
  ageFrom?: number;
  ageTo?: number;
  gender?: string;
  clientType?: string;
  city?: string;
  search?: string;
  limit: number;
}

export interface ClientView {
  externalId: string;
  client: string;
  birthDate?: string | null;
  age?: number | null;
  gender?: string | null;
  city?: string | null;
  municipality?: string | null;
  municipalityCode?: string | null;
  countryId?: string | null;
  lang?: string | null;
  clientType?: string | null;
  homeUnit?: string | null;
  defaultEventPayerType?: string | null;
  latestSaveDate?: string | null;
  latestSavePersonnelId?: number | null;
  sourceUpdatedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ClientFieldMetadataView {
  key: string;
  description: string;
  dataType?: string;
  filterable: boolean;
  includeInAiContext: boolean;
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AcuteConfigService } from '../acute/acute-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClientFieldMetadataView,
  ClientListFilters,
  ClientView,
} from './client-admin.types';

@Injectable()
export class ClientReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acuteConfigService: AcuteConfigService,
  ) {}

  async listClients(filters: ClientListFilters): Promise<ClientView[]> {
    const records = await this.prisma.repositoryRecord.findMany({
      where: this.buildRepositoryWhere(filters),
      orderBy: [
        { sourceUpdatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: filters.limit,
    });

    return records
      .map((record) => this.mapRepositoryRecordToClientView(record))
      .filter((client): client is ClientView => client !== null)
      .filter((client) => this.matchesBusinessFilters(client, filters))
      .filter((client) => this.matchesSearch(client, filters.search));
  }

  async countClients(filters: Omit<ClientListFilters, 'limit'>): Promise<number> {
    const records = await this.prisma.repositoryRecord.findMany({
      where: this.buildRepositoryWhere({
        ...filters,
        limit: 10_000,
      }),
      select: {
        externalId: true,
        payload: true,
      },
      take: 10_000,
    });

    return records
      .map((record) =>
        this.mapPayloadToClientView(record.externalId, record.payload as Prisma.JsonValue),
      )
      .filter((client): client is ClientView => client !== null)
      .filter((client) =>
        this.matchesBusinessFilters(client, {
          ...filters,
          limit: 10_000,
        }),
      )
      .filter((client) => this.matchesSearch(client, filters.search)).length;
  }

  async getSyncOverview() {
    const [syncState, latestRuns] = await Promise.all([
      this.prisma.entitySyncState.findUnique({
        where: { entityKey: 'client' },
      }),
      this.prisma.syncRun.findMany({
        where: { entityKey: 'client' },
        orderBy: { startedAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      entityKey: 'client',
      syncState,
      latestRuns,
    };
  }

  getClientMetadata(): { entityKey: string; importedFields: ClientFieldMetadataView[] } {
    const config = this.acuteConfigService.getEntityConfigOrThrow('client');

    return {
      entityKey: 'client',
      importedFields:
        config.importedFields?.map((field) => ({
          key: field.key,
          description: field.description,
          dataType: field.dataType,
          filterable: field.filterable === true,
          includeInAiContext: field.includeInAiContext !== false,
        })) ?? [],
    };
  }

  private buildRepositoryWhere(filters: ClientListFilters) {
    return {
      entityType: 'client',
    };
  }

  private mapRepositoryRecordToClientView(
    record: {
      externalId: string;
      payload: Prisma.JsonValue;
      sourceUpdatedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ): ClientView | null {
    const base = this.mapPayloadToClientView(record.externalId, record.payload);

    if (!base) {
      return null;
    }

    return {
      ...base,
      sourceUpdatedAt: record.sourceUpdatedAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private mapPayloadToClientView(
    externalId: string,
    payload: Prisma.JsonValue,
  ): ClientView | null {
    if (!this.isRecord(payload)) {
      return null;
    }

    return {
      externalId,
      client: this.getString(payload.client) ?? externalId,
      birthDate: this.getString(payload.birthDate),
      age: this.calculateAge(this.getString(payload.birthDate)),
      gender: this.getString(payload.gender),
      city: this.getString(payload.city),
      municipality: this.getString(payload.municipality),
      municipalityCode: this.getString(payload.municipalityCode),
      countryId: this.getString(payload.countryId),
      lang: this.getString(payload.lang),
      clientType: this.getString(payload.clientType),
      homeUnit: this.getString(payload.homeUnit),
      defaultEventPayerType: this.getString(payload.defaultEventPayerType),
      latestSaveDate: this.getString(payload.latestSaveDate),
      latestSavePersonnelId: this.getNumber(payload.latestSavePersonnelId),
    };
  }

  private matchesSearch(client: ClientView, search?: string): boolean {
    if (!search) {
      return true;
    }

    const needle = search.toLowerCase();
    const haystack = [
      client.client,
      client.externalId,
      client.city,
      client.municipality,
      client.clientType,
      client.gender,
      client.countryId,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLowerCase();

    return haystack.includes(needle);
  }

  private matchesBusinessFilters(client: ClientView, filters: ClientListFilters): boolean {
    if (filters.gender && client.gender !== filters.gender) {
      return false;
    }

    if (filters.clientType && client.clientType !== filters.clientType) {
      return false;
    }

    if (filters.city) {
      const city = client.city?.toLowerCase() ?? '';
      if (!city.includes(filters.city.toLowerCase())) {
        return false;
      }
    }

    if (filters.birthDateFrom && !this.isBirthDateOnOrAfter(client.birthDate, filters.birthDateFrom)) {
      return false;
    }

    if (filters.birthDateTo && !this.isBirthDateOnOrBefore(client.birthDate, filters.birthDateTo)) {
      return false;
    }

    if (typeof filters.ageFrom === 'number') {
      if (typeof client.age !== 'number' || client.age < filters.ageFrom) {
        return false;
      }
    }

    if (typeof filters.ageTo === 'number') {
      if (typeof client.age !== 'number' || client.age > filters.ageTo) {
        return false;
      }
    }

    return true;
  }

  private isRecord(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private getString(value: Prisma.JsonValue | undefined): string | null {
    return typeof value === 'string' ? value : null;
  }

  private getNumber(value: Prisma.JsonValue | undefined): number | null {
    return typeof value === 'number' ? value : null;
  }

  private calculateAge(birthDate?: string | null): number | null {
    if (!birthDate) {
      return null;
    }

    const birth = new Date(birthDate);
    if (Number.isNaN(birth.getTime())) {
      return null;
    }

    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDifference = today.getMonth() - birth.getMonth();

    if (
      monthDifference < 0 ||
      (monthDifference === 0 && today.getDate() < birth.getDate())
    ) {
      age -= 1;
    }

    return age;
  }

  private isBirthDateOnOrAfter(value: string | null | undefined, boundary: string): boolean {
    const date = this.toDateOnly(value);
    const from = this.toDateOnly(boundary);

    return Boolean(date && from && date >= from);
  }

  private isBirthDateOnOrBefore(value: string | null | undefined, boundary: string): boolean {
    const date = this.toDateOnly(value);
    const to = this.toDateOnly(boundary);

    return Boolean(date && to && date <= to);
  }

  private toDateOnly(value: string | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
}

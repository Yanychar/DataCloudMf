import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientReadService } from '../client-admin/client-read.service';
import { RunClientReportDto } from './dto/run-client-report.dto';
import { ClientReportResult } from './reporting-admin.types';
import { OpenAiReportingService } from './openai-reporting.service';

@Injectable()
export class ReportingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientReadService: ClientReadService,
    private readonly openAiReportingService: OpenAiReportingService,
  ) {}

  async runClientReport(dto: RunClientReportDto) {
    const limit = this.normalizeLimit(dto.options?.limit);

    const execution = await this.prisma.reportExecution.create({
      data: {
        entityKey: 'client',
        mode: 'ai_direct',
        prompt: dto.prompt,
        filters: (dto.filters ?? {}) as object,
        options: {
          limit,
          includeRawRows: dto.options?.includeRawRows ?? false,
        } as object,
        status: 'running',
      },
    });

    try {
      const metadata = this.clientReadService.getClientMetadata();
      const clients = await this.clientReadService.listClients({
        birthDateFrom: this.getString(dto.filters?.birthDateFrom),
        birthDateTo: this.getString(dto.filters?.birthDateTo),
        ageFrom: this.getNumber(dto.filters?.ageFrom),
        ageTo: this.getNumber(dto.filters?.ageTo),
        gender: this.getString(dto.filters?.gender),
        clientType: this.getString(dto.filters?.clientType),
        city: this.getString(dto.filters?.city),
        search: this.getString(dto.filters?.search),
        limit,
      });

      const result = this.openAiReportingService.isConfigured()
        ? await this.openAiReportingService.generateClientReport({
            prompt: dto.prompt,
            filters: (dto.filters ?? {}) as Record<string, unknown>,
            metadata: metadata.importedFields,
            rows: clients,
          })
        : this.buildStage1FallbackResult(dto.prompt, clients);
      const inputSample = clients.slice(0, 20);

      const updatedExecution = await this.prisma.reportExecution.update({
        where: { id: execution.id },
        data: {
          inputRowCount: clients.length,
          inputSample: inputSample as object,
          status: 'success',
          result: result as object,
          finishedAt: new Date(),
        },
      });

      return {
        executionId: updatedExecution.id,
        status: updatedExecution.status,
        mode: updatedExecution.mode,
        inputRowCount: updatedExecution.inputRowCount,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown report execution error';

      await this.prisma.reportExecution.update({
        where: { id: execution.id },
        data: {
          status: 'failed',
          errorMessage: message,
          finishedAt: new Date(),
        },
      });

      throw error;
    }
  }

  async listClientReportExecutions(limit?: number) {
    return this.prisma.reportExecution.findMany({
      where: { entityKey: 'client' },
      orderBy: { createdAt: 'desc' },
      take: this.normalizeHistoryLimit(limit),
    });
  }

  async getClientReportExecution(id: string) {
    return this.prisma.reportExecution.findUnique({
      where: { id },
    });
  }

  async previewClientReportInput(filters?: Record<string, unknown>) {
    const birthDateFrom = this.getString(filters?.birthDateFrom);
    const birthDateTo = this.getString(filters?.birthDateTo);
    const ageFrom = this.getNumber(filters?.ageFrom);
    const ageTo = this.getNumber(filters?.ageTo);
    const gender = this.getString(filters?.gender);
    const clientType = this.getString(filters?.clientType);
    const city = this.getString(filters?.city);
    const search = this.getString(filters?.search);

    const rowCount = await this.clientReadService.countClients({
      birthDateFrom,
      birthDateTo,
      ageFrom,
      ageTo,
      gender,
      clientType,
      city,
      search,
    });

    return {
      entityKey: 'client',
      rowCount,
      aiConfigured: this.openAiReportingService.isConfigured(),
      model: this.openAiReportingService.getConfiguredModel(),
      filters: {
        birthDateFrom,
        birthDateTo,
        ageFrom,
        ageTo,
        gender,
        clientType,
        city,
        search,
      },
      metadata: this.clientReadService.getClientMetadata(),
    };
  }

  private buildStage1FallbackResult(
    prompt: string,
    clients: Awaited<ReturnType<ClientReadService['listClients']>>,
  ): ClientReportResult {
    const byClientType = clients.reduce<Record<string, number>>((accumulator, client) => {
      const key = client.clientType ?? 'Unknown';
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});

    const byGender = clients.reduce<Record<string, number>>((accumulator, client) => {
      const key = client.gender ?? 'Unknown';
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});

    return {
      generator: 'local_fallback',
      note:
        'OpenAI reporting is not configured yet, so this local fallback result is being returned.',
      prompt,
      summary: `Prepared a Client report input with ${clients.length} matching records.`,
      truncated: false,
      rowCount: clients.length,
      sections: [
        {
          type: 'metric_list',
          title: 'Overview',
          items: [
            { label: 'Total clients', value: clients.length },
            ...Object.entries(byClientType).map(([label, value]) => ({ label: `clientType:${label}`, value })),
            ...Object.entries(byGender).map(([label, value]) => ({ label: `gender:${label}`, value })),
          ],
        },
        {
          type: 'table',
          title: 'Recent clients',
          columns: ['client', 'birthDate', 'age', 'gender', 'clientType', 'city', 'latestSaveDate'],
          rows: clients.slice(0, 20).map((client) => [
            client.client,
            client.birthDate ?? '',
            client.age ?? '',
            client.gender ?? '',
            client.clientType ?? '',
            client.city ?? '',
            client.latestSaveDate ?? '',
          ]),
        },
      ],
      notes: [
        'Set OPENAI_API_KEY to enable direct-AI reporting.',
      ],
    };
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private normalizeLimit(limit?: number): number {
    if (!Number.isFinite(limit) || !limit || limit <= 0) {
      return 200;
    }

    return Math.min(limit, 500);
  }

  private normalizeHistoryLimit(limit?: number): number {
    if (!Number.isFinite(limit) || !limit || limit <= 0) {
      return 20;
    }

    return Math.min(limit, 100);
  }
}

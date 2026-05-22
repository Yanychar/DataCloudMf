import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ClientFieldMetadataView, ClientView } from '../client-admin/client-admin.types';
import { ClientReportResult } from './reporting-admin.types';

@Injectable()
export class OpenAiReportingService {
  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  getConfiguredModel(): string {
    return this.configService.get<string>('OPENAI_REPORT_MODEL', 'gpt-5.5');
  }

  async generateClientReport(input: {
    prompt: string;
    filters: Record<string, unknown>;
    metadata: ClientFieldMetadataView[];
    rows: ClientView[];
  }): Promise<ClientReportResult> {
    const response = await axios.post(
      `${this.getBaseUrl()}/chat/completions`,
      {
        model: this.getConfiguredModel(),
        messages: [
          {
            role: 'system',
            content: [
              'You generate business reports over sanitized Client data.',
              'Use only the provided rows and metadata.',
              'Do not invent unavailable fields or hidden personal details.',
              'Return valid JSON that matches the required schema exactly.',
              'If the data is insufficient, say so in summary or notes instead of guessing.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              entity: 'Client',
              task: input.prompt,
              filters: input.filters,
              metadata: {
                fields: input.metadata,
              },
              rowCount: input.rows.length,
              rows: input.rows,
            }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'client_report_result',
            strict: true,
            schema: this.getReportJsonSchema(),
          },
        },
      },
      {
        headers: {
          Authorization: `Bearer ${this.getApiKey()}`,
          'Content-Type': 'application/json',
        },
        timeout: this.getTimeoutMs(),
      },
    );

    const rawContent = response.data?.choices?.[0]?.message?.content;
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      throw new Error('OpenAI report response did not contain JSON content.');
    }

    const parsed = JSON.parse(rawContent) as Omit<ClientReportResult, 'generator' | 'prompt' | 'model' | 'rowCount'>;

    return {
      generator: 'openai_direct',
      prompt: input.prompt,
      model: this.getConfiguredModel(),
      rowCount: input.rows.length,
      ...parsed,
    };
  }

  private getApiKey(): string {
    return this.configService.get<string>('OPENAI_API_KEY', '');
  }

  private getBaseUrl(): string {
    return this.configService.get<string>('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  }

  private getTimeoutMs(): number {
    return Number(this.configService.get<string>('OPENAI_TIMEOUT_MS', '60000'));
  }

  private getReportJsonSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'sections', 'notes', 'truncated'],
      properties: {
        summary: {
          type: 'string',
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'title'],
            properties: {
              type: {
                type: 'string',
                enum: ['metric_list', 'table', 'bullet_list'],
              },
              title: {
                type: 'string',
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['label', 'value'],
                  properties: {
                    label: { type: 'string' },
                    value: {
                      type: ['string', 'number', 'boolean', 'null'],
                    },
                  },
                },
              },
              columns: {
                type: 'array',
                items: { type: 'string' },
              },
              rows: {
                type: 'array',
                items: {
                  type: 'array',
                  items: {
                    type: ['string', 'number', 'boolean', 'null'],
                  },
                },
              },
            },
          },
        },
        notes: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        truncated: {
          type: 'boolean',
        },
      },
    };
  }
}

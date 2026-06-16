import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { hostname } from 'os';
import { lastValueFrom } from 'rxjs';

export interface TelegramSendResult {
  sent: boolean;
  skippedReason?: 'disabled' | 'missing_config';
  messageId?: number;
  errorMessage?: string;
}

export interface SyncFailureNotification {
  entityKey: string;
  flowType: 'raw' | 'stage';
  trigger: 'scheduled' | 'manual' | 'test';
  errorMessage: string;
}

export interface RawWindowFailureNotification {
  entityKey: string;
  trigger: 'scheduled' | 'manual';
  windowFrom: string;
  windowTo: string;
  attemptCount: number;
  windowSize: number;
  windowUnit?: string;
  errorMessage: string;
}

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private readonly telegramTimeoutMs = 10_000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  async sendTestMessage(): Promise<TelegramSendResult> {
    return this.sendMessage(
      [
        'Medfin Data Cloud Telegram test',
        '',
        `Environment: ${this.configService.get<string>('APP_ENV', 'development')}`,
        `Host: ${hostname()}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
    );
  }

  async notifySyncFailure(notification: SyncFailureNotification): Promise<void> {
    const result = await this.sendMessage(this.buildSyncFailureMessage(notification));

    if (result.sent) {
      return;
    }

    if (result.skippedReason) {
      this.logger.warn(`Telegram sync failure notification skipped: ${result.skippedReason}.`);
      return;
    }

    this.logger.warn(
      `Telegram sync failure notification could not be sent: ${result.errorMessage ?? 'unknown error'}`,
    );
  }

  async notifyRawWindowFailure(notification: RawWindowFailureNotification): Promise<void> {
    const result = await this.sendMessage(this.buildRawWindowFailureMessage(notification));

    if (result.sent) {
      return;
    }

    if (result.skippedReason) {
      this.logger.warn(`Telegram raw window failure notification skipped: ${result.skippedReason}.`);
      return;
    }

    this.logger.warn(
      `Telegram raw window failure notification could not be sent: ${result.errorMessage ?? 'unknown error'}`,
    );
  }

  private async sendMessage(text: string): Promise<TelegramSendResult> {
    if (!this.isEnabled()) {
      return {
        sent: false,
        skippedReason: 'disabled',
      };
    }

    const botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN', '').trim();
    const chatId = this.configService.get<string>('TELEGRAM_GROUP_CHAT_ID', '').trim();

    if (!botToken || !chatId) {
      return {
        sent: false,
        skippedReason: 'missing_config',
      };
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    try {
      const response = await lastValueFrom(
        this.httpService.post(
          url,
          {
            chat_id: chatId,
            text: this.truncateTelegramMessage(text),
            disable_web_page_preview: true,
          },
          {
            timeout: this.telegramTimeoutMs,
          },
        ),
      );

      const data = response.data as { ok?: boolean; result?: { message_id?: number } };
      if (data.ok !== true) {
        return {
          sent: false,
          errorMessage: 'Telegram API returned ok=false.',
        };
      }

      return {
        sent: true,
        messageId: data.result?.message_id,
      };
    } catch (error) {
      return {
        sent: false,
        errorMessage: this.formatTelegramError(error),
      };
    }
  }

  private buildSyncFailureMessage(notification: SyncFailureNotification): string {
    return [
      'Medfin Data Cloud sync failed',
      '',
      `Environment: ${this.configService.get<string>('APP_ENV', 'development')}`,
      `Host: ${hostname()}`,
      `Flow: ${notification.flowType}`,
      `Entity: ${notification.entityKey}`,
      `Trigger: ${notification.trigger}`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${notification.errorMessage}`,
    ].join('\n');
  }

  private buildRawWindowFailureMessage(notification: RawWindowFailureNotification): string {
    return [
      'Medfin Data Cloud raw sync window failed',
      '',
      `Environment: ${this.configService.get<string>('APP_ENV', 'development')}`,
      `Host: ${hostname()}`,
      `Entity: ${notification.entityKey}`,
      `Trigger: ${notification.trigger}`,
      `Window: ${notification.windowFrom} -> ${notification.windowTo}`,
      `Attempts: ${notification.attemptCount}`,
      `Window size: ${notification.windowSize} ${notification.windowUnit ?? 'unit'}`,
      `Time: ${new Date().toISOString()}`,
      `Error: ${notification.errorMessage}`,
    ].join('\n');
  }

  private isEnabled(): boolean {
    return this.configService.get<string>('TELEGRAM_NOTIFICATIONS_ENABLED', 'false') === 'true';
  }

  private truncateTelegramMessage(text: string): string {
    const maxTelegramLength = 4096;
    if (text.length <= maxTelegramLength) {
      return text;
    }

    return `${text.slice(0, maxTelegramLength - 20)}\n... truncated`;
  }

  private formatTelegramError(error: unknown): string {
    const axiosError = error as AxiosError<{ description?: string }>;

    if (axiosError.response) {
      const description = axiosError.response.data?.description;
      return `HTTP ${axiosError.response.status}${description ? `: ${description}` : ''}`;
    }

    const details = [
      axiosError.code ? `code=${axiosError.code}` : undefined,
      axiosError.message ? `message=${axiosError.message}` : undefined,
      axiosError.cause instanceof Error && axiosError.cause.message
        ? `cause=${axiosError.cause.message}`
        : undefined,
      axiosError.name ? `name=${axiosError.name}` : undefined,
    ].filter(Boolean);

    if (details.length) {
      return details.join('; ');
    }

    return error instanceof Error && error.message ? error.message : 'Unknown Telegram request error';
  }
}

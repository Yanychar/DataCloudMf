import { Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TelegramNotifierService } from './telegram-notifier.service';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly telegramNotifierService: TelegramNotifierService) {}

  @Post('telegram/test')
  @ApiOperation({ summary: 'Send a Telegram test notification' })
  sendTelegramTest() {
    return this.telegramNotifierService.sendTestMessage();
  }
}

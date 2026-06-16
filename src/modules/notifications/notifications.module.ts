import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { NotificationsController } from './notifications.controller';
import { TelegramNotifierService } from './telegram-notifier.service';

@Module({
  imports: [HttpModule],
  providers: [TelegramNotifierService],
  controllers: [NotificationsController],
  exports: [TelegramNotifierService],
})
export class NotificationsModule {}

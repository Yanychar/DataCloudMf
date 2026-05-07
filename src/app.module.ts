import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AcuteModule } from './modules/acute/acute.module';
import { HealthController } from './modules/health/health.controller';
import { RepositoryModule } from './modules/repository/repository.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RepositoryModule,
    AcuteModule,
    IngestionModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

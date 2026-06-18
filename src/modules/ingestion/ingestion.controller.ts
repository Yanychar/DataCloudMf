import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RecoverRawWindowDto } from './dto/recover-raw-window.dto';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';
import { IngestionSchedulerService } from './ingestion-scheduler.service';

@ApiTags('ingestion')
@Controller('ingestion')
export class IngestionController {
  constructor(
    private readonly ingestionOrchestratorService: IngestionOrchestratorService,
    private readonly ingestionSchedulerService: IngestionSchedulerService,
  ) {}

  @Get('entities')
  @ApiOperation({ summary: 'List configured Acute entities for synchronization' })
  getEntityConfigs() {
    return this.ingestionOrchestratorService.getEntityConfigs();
  }

  @Get('scheduler')
  @ApiOperation({ summary: 'Show raw and stage scheduler status' })
  getSchedulerStatus() {
    return this.ingestionSchedulerService.getSchedulerStatus();
  }

  @Get('enum-lookup/:entityKey/:fieldKey')
  @ApiOperation({ summary: 'List enum lookup values for one staged field' })
  getEnumLookupValues(
    @Param('entityKey') entityKey: string,
    @Param('fieldKey') fieldKey: string,
  ) {
    return this.ingestionOrchestratorService.getEnumLookupValues(entityKey, fieldKey);
  }

  @Post('sync/:entityKey')
  @ApiOperation({ summary: 'Run full sync for a single entity immediately (raw then stage)' })
  syncEntity(@Param('entityKey') entityKey: string) {
    return this.ingestionOrchestratorService.syncEntity(entityKey);
  }

  @Post('raw/:entityKey')
  @ApiOperation({ summary: 'Run raw Acute-to-RepositoryRecord sync for a single entity immediately' })
  syncRawEntity(@Param('entityKey') entityKey: string) {
    return this.ingestionOrchestratorService.syncRawEntity(entityKey);
  }

  @Post('raw/:entityKey/window')
  @ApiOperation({ summary: 'Recover one explicit raw date window without moving the sync cursor' })
  recoverRawWindow(
    @Param('entityKey') entityKey: string,
    @Body() dto: RecoverRawWindowDto,
  ) {
    return this.ingestionOrchestratorService.recoverRawWindow(entityKey, dto);
  }

  @Post('stage/:entityKey')
  @ApiOperation({ summary: 'Run RepositoryRecord-to-staging sync for a single entity immediately' })
  stageEntity(@Param('entityKey') entityKey: string) {
    return this.ingestionOrchestratorService.stageEntity(entityKey);
  }
}

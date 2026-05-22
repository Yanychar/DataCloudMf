import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IngestionOrchestratorService } from './ingestion-orchestrator.service';

@ApiTags('ingestion')
@Controller('ingestion')
export class IngestionController {
  constructor(private readonly ingestionOrchestratorService: IngestionOrchestratorService) {}

  @Get('entities')
  @ApiOperation({ summary: 'List configured Acute entities for synchronization' })
  getEntityConfigs() {
    return this.ingestionOrchestratorService.getEntityConfigs();
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

  @Post('stage/:entityKey')
  @ApiOperation({ summary: 'Run RepositoryRecord-to-staging sync for a single entity immediately' })
  stageEntity(@Param('entityKey') entityKey: string) {
    return this.ingestionOrchestratorService.stageEntity(entityKey);
  }
}

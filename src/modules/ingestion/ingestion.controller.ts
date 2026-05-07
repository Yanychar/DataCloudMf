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
  @ApiOperation({ summary: 'Run sync for a single entity immediately' })
  syncEntity(@Param('entityKey') entityKey: string) {
    return this.ingestionOrchestratorService.syncEntity(entityKey);
  }
}

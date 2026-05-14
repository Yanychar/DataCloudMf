import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcuteClientService } from './acute-client.service';
import { AcuteConfigService } from './acute-config.service';
import { AcuteRequestDto } from './dto/acute-request.dto';

@ApiTags('acute-test')
@Controller('acute-test')
export class AcuteTestController {
  constructor(
    private readonly acuteClientService: AcuteClientService,
    private readonly acuteConfigService: AcuteConfigService,
  ) {}

  @Get('ping')
  @ApiOperation({ summary: 'Check Acute client configuration' })
  ping() {
    return this.acuteClientService.ping();
  }

  @Post('request')
  @ApiOperation({ summary: 'Send a raw Acute request for testing' })
  request(
    @Body() dto: AcuteRequestDto,
    @Query('dryRun') dryRun?: string,
  ) {
    if (dryRun === 'true') {
      return this.acuteClientService.buildRequestPreviewWithOptions({
        path: dto.path,
        method: dto.method,
        params: dto.params,
        body: dto.body,
        timeoutMs: dto.timeoutMs,
      });
    }

    return this.acuteClientService.request(dto.path, dto.params, {
      method: dto.method,
      body: dto.body,
      timeoutMs: dto.timeoutMs,
      treatItemNotFoundAsEmpty: dto.treatItemNotFoundAsEmpty,
    });
  }

  @Post('entity/:entityKey/fetch')
  @ApiOperation({ summary: 'Fetch an entity from Acute using the configured endpoint' })
  fetchConfiguredEntity(
    @Param('entityKey') entityKey: string,
    @Query('since') since?: string,
    @Query('dryRun') dryRun?: string,
  ) {
    const config = this.acuteConfigService.getEntityConfigOrThrow(entityKey);

    if (dryRun === 'true') {
      return this.acuteClientService.buildEntityRequestPreview(
        config,
        since ? new Date(since) : undefined,
      );
    }

    return this.acuteClientService.fetchEntity(config, since ? new Date(since) : undefined);
  }
}

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
  @ApiOperation({ summary: 'Send a raw GET request to Acute for testing' })
  request(@Body() dto: AcuteRequestDto) {
    return this.acuteClientService.request(dto.path, dto.params);
  }

  @Post('entity/:entityKey/fetch')
  @ApiOperation({ summary: 'Fetch an entity from Acute using the configured endpoint' })
  fetchConfiguredEntity(
    @Param('entityKey') entityKey: string,
    @Query('since') since?: string,
  ) {
    const config = this.acuteConfigService.getEntityConfigOrThrow(entityKey);
    return this.acuteClientService.fetchEntity(config, since ? new Date(since) : undefined);
  }
}

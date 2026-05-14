import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ClientReadService } from './client-read.service';

@ApiTags('admin-clients')
@Controller('admin/clients')
export class ClientAdminController {
  constructor(private readonly clientReadService: ClientReadService) {}

  @Get()
  @ApiOperation({ summary: 'List normalized client records from the repository' })
  @ApiQuery({ name: 'birthDateFrom', required: false })
  @ApiQuery({ name: 'birthDateTo', required: false })
  @ApiQuery({ name: 'ageFrom', required: false })
  @ApiQuery({ name: 'ageTo', required: false })
  @ApiQuery({ name: 'gender', required: false })
  @ApiQuery({ name: 'clientType', required: false })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listClients(
    @Query('birthDateFrom') birthDateFrom?: string,
    @Query('birthDateTo') birthDateTo?: string,
    @Query('ageFrom') ageFrom?: string,
    @Query('ageTo') ageTo?: string,
    @Query('gender') gender?: string,
    @Query('clientType') clientType?: string,
    @Query('city') city?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.clientReadService.listClients({
      birthDateFrom,
      birthDateTo,
      ageFrom: this.normalizeOptionalNumber(ageFrom),
      ageTo: this.normalizeOptionalNumber(ageTo),
      gender,
      clientType,
      city,
      search,
      limit: this.normalizeLimit(limit),
    });
  }

  @Get('count')
  @ApiOperation({ summary: 'Count normalized client records matching the supplied filters' })
  @ApiQuery({ name: 'birthDateFrom', required: false })
  @ApiQuery({ name: 'birthDateTo', required: false })
  @ApiQuery({ name: 'ageFrom', required: false })
  @ApiQuery({ name: 'ageTo', required: false })
  @ApiQuery({ name: 'gender', required: false })
  @ApiQuery({ name: 'clientType', required: false })
  @ApiQuery({ name: 'city', required: false })
  @ApiQuery({ name: 'search', required: false })
  countClients(
    @Query('birthDateFrom') birthDateFrom?: string,
    @Query('birthDateTo') birthDateTo?: string,
    @Query('ageFrom') ageFrom?: string,
    @Query('ageTo') ageTo?: string,
    @Query('gender') gender?: string,
    @Query('clientType') clientType?: string,
    @Query('city') city?: string,
    @Query('search') search?: string,
  ) {
    return this.clientReadService.countClients({
      birthDateFrom,
      birthDateTo,
      ageFrom: this.normalizeOptionalNumber(ageFrom),
      ageTo: this.normalizeOptionalNumber(ageTo),
      gender,
      clientType,
      city,
      search,
    });
  }

  @Get('metadata')
  @ApiOperation({ summary: 'Get imported Client field metadata used for admin and AI context' })
  getClientMetadata() {
    return this.clientReadService.getClientMetadata();
  }

  @Get('sync-overview')
  @ApiOperation({ summary: 'Get latest sync state and recent SyncRun entries for Client' })
  getSyncOverview() {
    return this.clientReadService.getSyncOverview();
  }

  private normalizeLimit(limit?: string): number {
    const parsed = Number(limit);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 100;
    }

    return Math.min(parsed, 1000);
  }

  private normalizeOptionalNumber(value?: string): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}

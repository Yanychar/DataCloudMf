import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReportingAdminService } from './reporting-admin.service';
import { RunClientReportDto } from './dto/run-client-report.dto';

@ApiTags('admin-reports')
@Controller('admin/reports/client')
export class ReportingAdminController {
  constructor(private readonly reportingAdminService: ReportingAdminService) {}

  @Post('run')
  @ApiOperation({ summary: 'Run a Stage 1 direct Client report execution' })
  runClientReport(@Body() dto: RunClientReportDto) {
    return this.reportingAdminService.runClientReport(dto);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview the input row count for a Stage 1 Client report' })
  previewClientReportInput(@Body('filters') filters?: Record<string, unknown>) {
    return this.reportingAdminService.previewClientReportInput(filters);
  }

  @Get('executions')
  @ApiOperation({ summary: 'List recent Client report executions' })
  @ApiQuery({ name: 'limit', required: false })
  listClientReportExecutions(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    return this.reportingAdminService.listClientReportExecutions(
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }

  @Get('executions/:id')
  @ApiOperation({ summary: 'Get one Client report execution by id' })
  getClientReportExecution(@Param('id') id: string) {
    return this.reportingAdminService.getClientReportExecution(id);
  }
}

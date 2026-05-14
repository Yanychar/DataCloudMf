import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class RunClientReportDto {
  @ApiProperty({
    description: 'Natural-language report request for Client data',
    example: 'Summarize clients changed in the selected period and show counts by clientType.',
  })
  @IsString()
  prompt!: string;

  @ApiProperty({
    required: false,
    description: 'Optional filters applied before report generation',
    example: { ageFrom: 18, ageTo: 65, gender: 'Female', clientType: 'PersonalCustomer', city: 'Helsinki' },
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    description: 'Optional execution options',
    example: { limit: 200, includeRawRows: false },
  })
  @IsOptional()
  @IsObject()
  options?: {
    limit?: number;
    includeRawRows?: boolean;
  };
}

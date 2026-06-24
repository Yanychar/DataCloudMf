import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class RecoverRawFromDateDto {
  @ApiProperty({
    description: 'First invoice date to recover. Each date from this value through today is recovered separately.',
    example: '2026-05-15',
  })
  @IsString()
  from!: string;

  @ApiProperty({
    required: false,
    description: 'Optional note stored in each daily SyncRun.syncContext for audit/history.',
    example: 'Recover invoice raw data from May 15, 2026 through today.',
  })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({
    required: false,
    description: 'Optional Acute timeout override in milliseconds for each daily recovery request.',
    example: 60000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;
}
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class RecoverRawWindowDto {
  @ApiProperty({
    description: 'Inclusive raw window start. Use YYYY-MM-DD for date-based endpoints.',
    example: '2026-05-15',
  })
  @IsString()
  from!: string;

  @ApiProperty({
    description: 'Raw window end. Use the same date for a one-day Acute ledger recovery.',
    example: '2026-05-15',
  })
  @IsString()
  to!: string;

  @ApiProperty({
    required: false,
    description: 'Optional note stored in SyncRun.syncContext for audit/history.',
    example: 'Recover quarantined invoice raw window from May 15, 2026.',
  })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiProperty({
    required: false,
    description: 'Optional showEvents override for this recovery request.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  showEvents?: boolean;

  @ApiProperty({
    required: false,
    description: 'Optional Acute timeout override in milliseconds for this recovery request.',
    example: 60000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;
}

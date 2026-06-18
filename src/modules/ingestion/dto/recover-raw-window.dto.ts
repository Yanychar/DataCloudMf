import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RecoverRawWindowDto {
  @ApiProperty({
    description: 'Inclusive raw window start. Use YYYY-MM-DD for date-based endpoints.',
    example: '2026-05-15',
  })
  @IsString()
  from!: string;

  @ApiProperty({
    description: 'Exclusive raw window end. Use the next day for a one-day recovery.',
    example: '2026-05-16',
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
}

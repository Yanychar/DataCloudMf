import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class AcuteRequestDto {
  @ApiProperty({
    description: 'Relative Acute API path or full endpoint path',
    example: '/patients',
  })
  @IsString()
  path!: string;

  @ApiProperty({
    required: false,
    description: 'Query params sent to Acute',
    example: { updatedFrom: '2026-04-01T00:00:00.000Z' },
  })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

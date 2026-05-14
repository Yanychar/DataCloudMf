import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class AcuteRequestDto {
  @ApiProperty({
    required: false,
    description: 'HTTP method used for the Acute request',
    example: 'GET',
    enum: ['GET', 'POST'],
  })
  @IsOptional()
  @IsIn(['GET', 'POST'])
  method?: 'GET' | 'POST';

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

  @ApiProperty({
    required: false,
    description: 'JSON body sent to Acute for POST requests',
    example: { onlyValid: true },
  })
  @IsOptional()
  @IsObject()
  body?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    description: 'Optional timeout override in milliseconds for this test request',
    example: 60000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @ApiProperty({
    required: false,
    description: 'Treat ITEM_NOT_FOUND:<Entity> as an empty result for debugging',
    example: 'Client',
  })
  @IsOptional()
  @IsString()
  treatItemNotFoundAsEmpty?: string;
}

import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpsertMessageDto {
  @ApiProperty({
    example: {
      'en-IN': 'Driver is on the way',
      'hi-IN': 'ड्राइवर आ रहा है',
      'te-IN': 'డ్రైవర్ వస్తున్నాడు',
    },
  })
  @IsObject()
  message!: Record<string, string>;

  @ApiPropertyOptional({ example: 'global' })
  @IsOptional()
  @IsString()
  scope?: string;

  @ApiPropertyOptional({ example: 'Shown when driver accepts' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}

export class MessageBulkDto {
  @ApiProperty({ type: [UpsertMessageDto] })
  messages!: Array<{
    key: string;
    scope?: string;
    message: Record<string, string>;
    description?: string;
  }>;
}

export class MessageResponseDto {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  message!: Record<string, string>;
}

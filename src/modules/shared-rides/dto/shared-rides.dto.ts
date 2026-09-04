import {
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePoolDto {
  @ApiProperty({ example: 'SHE_SHARE' })
  @IsString()
  categoryCode!: string;

  @ApiProperty({ example: 'Hyderabad' })
  @IsString()
  city!: string;

  @ApiProperty()
  @IsLatitude()
  originLat!: number;

  @ApiProperty()
  @IsLongitude()
  originLon!: number;

  @ApiProperty()
  @IsLatitude()
  destLat!: number;

  @ApiProperty()
  @IsLongitude()
  destLon!: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  maxSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class JoinPoolDto {
  @ApiProperty()
  @IsUUID()
  poolId!: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  seats?: number;
}

export class CreateGroupDto {
  @ApiProperty({
    example: 'PUBLIC',
    enum: ['PUBLIC', 'PRIVATE', 'COMMUNITY', 'CORPORATE'],
  })
  @IsString()
  type!: 'PUBLIC' | 'PRIVATE' | 'COMMUNITY' | 'CORPORATE';

  @ApiProperty({ example: 'My Office Commute' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'Hyderabad' })
  @IsOptional()
  @IsString()
  city?: string;
}

import {
  IsEmail,
  IsOptional,
  IsString,
  IsLatitude,
  IsLongitude,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ankur' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Pandey' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ example: 'ankur@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Uploaded avatar URL' })
  @IsOptional()
  @IsString()
  profileImageUrl?: string;
}

export class SavedLocationDto {
  @ApiProperty({ example: 'HOME', description: 'Label for the saved place' })
  @IsString()
  @MaxLength(50)
  label: string;

  @ApiProperty({ example: 28.7041 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: 77.1025 })
  @IsLongitude()
  lon: number;

  @ApiPropertyOptional({ example: 'Sector 62, Noida' })
  @IsOptional()
  @IsString()
  address?: string;
}

/* ------------------------------ responses ------------------------------ */

export class UserProfileDto {
  @ApiProperty({ example: 'Ankur Pandey' })
  name: string;

  @ApiProperty({ example: 'ankur@example.com', nullable: true })
  email: string | null;

  @ApiProperty({ example: '+919876543210' })
  phone: string;

  @ApiProperty({
    example: 'https://cdn.example.com/avatars/a.jpg',
    nullable: true,
  })
  profileImage: string | null;

  @ApiProperty({ example: 4.9 })
  rating: number;
}

export class UpdatedUserDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  id: string;

  @ApiProperty({ example: '+919876543210' })
  phoneNumber: string;

  @ApiProperty({ example: 'Ankur', nullable: true })
  firstName: string | null;

  @ApiProperty({ example: 'Pandey', nullable: true })
  lastName: string | null;

  @ApiProperty({ example: 'ankur@example.com', nullable: true })
  email: string | null;

  @ApiProperty({ example: null, nullable: true })
  profileImageUrl: string | null;
}

export class SavedLocationResultDto {
  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  id: string;

  @ApiProperty({ example: 'HOME' })
  label: string;

  @ApiProperty({ example: 28.7041 })
  lat: number;

  @ApiProperty({ example: 77.1025 })
  lon: number;

  @ApiProperty({ example: 'Sector 62, Noida', nullable: true })
  address: string | null;

  @ApiProperty({ example: 'b0e2a3f4-1c2d-4e5f-8a9b-0c1d2e3f4a5b' })
  userId: string;
}

export class SavedLocationListResultDto {
  @ApiProperty({ type: [SavedLocationResultDto] })
  locations: SavedLocationResultDto[];
}

export class SavedLocationSaveResultDto {
  @ApiProperty({ type: SavedLocationResultDto })
  saved: SavedLocationResultDto;
}

export class UpdatedUserResultDto {
  @ApiProperty({ type: UpdatedUserDto })
  updatedUser: UpdatedUserDto;
}

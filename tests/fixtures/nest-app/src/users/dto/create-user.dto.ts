import { IsArray, IsEmail, IsEnum, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum Role {
  Admin = 'admin',
  Member = 'member',
}

class AddressDto {
  @IsString()
  city: string;
}

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsInt()
  age?: number;

  @IsEnum(Role)
  role: Role;

  @ValidateNested()
  @Type(() => AddressDto)
  address: AddressDto;

  @IsArray()
  @IsString({ each: true })
  tags: string[];
}

import { IsOptional, IsString } from 'class-validator';

export class ListUsersQuery {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  sort?: 'asc' | 'desc';
}

import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class SearchArticlesDto {
  @IsString()
  term: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;
}

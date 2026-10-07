import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ArticlesService } from './articles.service';
import { SearchArticlesDto } from './dto/search-articles.dto';

// @ApiBearerAuth es solo documentación: la auth real viene de forRoutes().
@ApiBearerAuth()
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articlesService: ArticlesService) {}

  @Get()
  findAll(@Query() query) {
    return this.articlesService.findAll(query);
  }

  @Get('search')
  search(@Query() filters: SearchArticlesDto) {
    return filters;
  }

  @Post()
  create(@Body('article') article) {
    return this.articlesService.create(article);
  }

  @Delete(':slug')
  remove(@Param('slug') slug: string) {
    return slug;
  }

  @Post(':slug/cover')
  @UseInterceptors(FileInterceptor('cover'))
  upload(@UploadedFile() cover: unknown, @Body('caption') caption: string) {
    return { cover, caption };
  }
}

import { Controller, Get, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AuthMiddleware } from './auth.middleware';
import { ArticlesController } from './articles/articles.controller';

@Controller()
export class HomeController {
  @Get()
  home() {
    return { ok: true };
  }
}

@Module({ controllers: [HomeController, ArticlesController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: 'articles', method: RequestMethod.POST }, { path: 'articles/:slug', method: RequestMethod.DELETE });
  }
}

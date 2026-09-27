import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  app.setGlobalPrefix(configService.getOrThrow('app.apiPrefix', { infer: true }), { exclude: ['/'] });
  await app.listen(3000);
}
bootstrap();

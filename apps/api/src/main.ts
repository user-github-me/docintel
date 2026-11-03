import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config/config';
import { DatabaseService } from './database/database.service';

async function bootstrap() {
  const config = loadConfig();
  const logger = new Logger('bootstrap');

  if (config.APP_ROLE === 'worker') {
    const ctx = await NestFactory.createApplicationContext(AppModule.register(config));
    if (config.RUN_MIGRATIONS) await ctx.get(DatabaseService).migrate();
    ctx.enableShutdownHooks();
    logger.log('worker started (queues: ingest, pages, analyze, index)');
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), { bodyParser: true });
  if (config.RUN_MIGRATIONS) await app.get(DatabaseService).migrate();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.enableCors({ origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PATCH', 'DELETE'] });
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('DocIntel API')
    .setDescription('AI-powered document intelligence: upload invoices (PDF, images, Excel, CSV), track processing, review extracted data, correct, search and cross-verify.')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger), { jsonDocumentUrl: 'docs/openapi.json' });

  await app.listen(config.PORT, '0.0.0.0');
  logger.log(`API listening on :${config.PORT} (role=${config.APP_ROLE}); docs at /docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

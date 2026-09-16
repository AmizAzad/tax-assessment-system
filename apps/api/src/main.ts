import 'reflect-metadata';
import helmet from 'helmet';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadConfiguration } from './config/configuration';
import { DomainExceptionFilter } from './platform/audit/domain-exception.filter';

async function bootstrap(): Promise<void> {
  const config = loadConfiguration();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  /**
   * Security headers.
   *
   * Plan reference: V2 section 20 ("CSP and standard security headers").
   *
   * The API returns JSON, so several of these headers do nothing for it
   * directly. They are set anyway, because a response that can be framed,
   * sniffed into a different content type, or reflected into a page is the
   * kind of thing a tester finds and nobody can explain why it was left.
   *
   * The content security policy is the strictest form there is: a JSON API
   * has no legitimate need to load a script, a style or a frame, so
   * everything is denied and nothing is carved out.
   */
  const strictPolicy = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // A notice PDF is downloaded rather than embedded, and
    // cross-origin-embedder-policy buys nothing on a JSON API.
    crossOriginEmbedderPolicy: false,
    // Meaningless over plain HTTP locally; in a deployment the ingress
    // terminates TLS and this is the header it should be sending.
    hsts: config.env === 'production',
  });

  // Everything except the documentation, which is a real HTML page with its
  // own scripts and styles and would be blanked by the policy above. It gets
  // the same headers with the policy relaxed rather than being excluded from
  // hardening altogether.
  const docsPolicy = helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });

  app.use((request: { path?: string; url: string }, response: unknown, next: () => void) => {
    const path = request.path ?? request.url;
    const apply = path.startsWith('/api/docs') ? docsPolicy : strictPolicy;
    (apply as unknown as (req: unknown, res: unknown, next: () => void) => void)(
      request,
      response,
      next,
    );
  });

  /**
   * Cross-origin access.
   *
   * An allowlist from configuration, never `*`. Credentials are enabled
   * because the browser sends a bearer token, and a wildcard origin with
   * credentials is rejected by browsers anyway — the honest version of that
   * rule is to name the origins.
   */
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id', 'Content-Disposition'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api/v1', {
    // Health is probed by the orchestrator, which should not have to know the
    // API's versioning scheme.
    exclude: ['health/live', 'health/ready'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown properties rather than stripping them silently: an
      // unexpected field in a submission is a signal, not noise.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Without this every refused transition surfaces as a 500 and a client
  // cannot tell a rule from a fault (plan 14.5).
  app.useGlobalFilters(new DomainExceptionFilter());

  app.enableShutdownHooks();

  // OpenAPI is the single source of truth for the front-end client
  // (plan section 14.5).
  const openApi = new DocumentBuilder()
    .setTitle('Tax Assessment System API')
    .setDescription('Configuration-driven tax assessment platform')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, openApi));

  await app.listen(config.port);

  const logger = new Logger('bootstrap');
  logger.log(`API listening on http://localhost:${config.port}`);
  logger.log(`OpenAPI at http://localhost:${config.port}/api/docs`);
  logger.log(`Readiness at http://localhost:${config.port}/health/ready`);
  logger.log(`Cross-origin callers allowed: ${config.allowedOrigins.join(', ') || 'none'}`);
}

void bootstrap();

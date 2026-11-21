/**
 * API bootstrap.
 *
 * Startup order matters and is deliberate:
 *   1. Parse the environment. A misconfigured process must die here, not serve
 *      half-broken requests.
 *   2. Install process-level guards for unhandled rejections and exceptions, so
 *      a crash is logged in full before the process exits.
 *   3. Build the Nest application with a strict global validation pipe.
 *   4. Configure HTTP hardening, CORS, and graceful shutdown.
 *   5. Listen on 0.0.0.0 so the container is reachable through its service VIP.
 */

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module.js';
import { parseEnv } from './config/env.js';
import { JsonLogger } from './common/logging/logger.js';

const env = parseEnv(process.env);
const bootLogger = new JsonLogger(env.LOG_LEVEL);

process.on('unhandledRejection', (reason) => {
  bootLogger.event('fatal', 'process.unhandled_rejection', {
    reason:
      reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : reason,
  });
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  bootLogger.event('fatal', 'process.uncaught_exception', {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: bootLogger,
    // Trust the platform proxy so `request.ip` reflects the client, not the load
    // balancer. Without this every rate limit would key on the same address.
    bodyParser: true,
  });

  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.enableShutdownHooks();

  app.use(cookieParser());

  // Health probes live outside the versioned API surface: orchestrators should
  // not have to understand versioning, and the routes must stay stable forever.
  app.setGlobalPrefix('api', {
    exclude: ['health/live', 'health/ready'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Validation is applied per route with an explicit zod schema (see ZodBody).
  // There is deliberately no global metadata-based pipe: relying on
  // `design:paramtypes` makes validation a build-tool detail, and a transpiler
  // that omits metadata silently disables it. Explicit pipes cannot be skipped.

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  // Reject oversized payloads before they reach a parser.
  app.useBodyParser('json', { limit: '256kb' });

  await app.listen(env.PORT, env.HOST);

  bootLogger.event('info', 'api.started', {
    port: env.PORT,
    host: env.HOST,
    environment: env.NODE_ENV,
  });
};

await bootstrap();

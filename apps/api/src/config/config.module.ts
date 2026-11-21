/**
 * Configuration module.
 *
 * The parsed `Env` object is provided under a symbol token rather than as a
 * Nest config namespace: it is a frozen, fully-typed value, so dependency
 * injection carries the type all the way to the consumer without string keys.
 */

import { Global, Module } from '@nestjs/common';

import { type Env, parseEnv } from './env.js';
import { JsonLogger } from '../common/logging/logger.js';

export const ENV = Symbol('ENV');

@Global()
@Module({
  // Exported so any module that declares an infrastructure provider (Redis,
  // Postgres, cache) can import it and resolve ENV and JsonLogger in its own
  // injector context, rather than relying on the root module having run first.
  exports: [ENV, JsonLogger],
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => parseEnv(process.env),
    },
    {
      provide: JsonLogger,
      useFactory: (env: Env): JsonLogger => new JsonLogger(env.LOG_LEVEL),
      inject: [ENV],
    },
  ],
})
export class ConfigModule {}

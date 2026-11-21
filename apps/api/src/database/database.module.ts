/**
 * Database access module.
 *
 * `DatabasePools` is **global** because its value depends on being a singleton:
 * it owns one `pg.Pool` per endpoint, and every module that declares the provider
 * locally gets its own pool. Three feature modules would then hold 3 × the
 * configured connection budget, which exhausts Postgres long before the traffic
 * does. Declaring it once and sharing it is the whole point of the class.
 */

import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module.js';
import { DatabasePools } from './pool.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [DatabasePools],
  exports: [DatabasePools],
})
export class DatabaseModule {}

import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module.js';

import { DatabasePools } from '../../database/pool.js';
import { RedisConnection } from '../../database/redis.js';
import { cacheProvider } from '../../database/cache.provider.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [DatabasePools, RedisConnection, cacheProvider],
})
export class HealthModule {}

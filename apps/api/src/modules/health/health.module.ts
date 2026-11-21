import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module.js';
import { CacheModule } from '../../database/cache.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ConfigModule, DatabaseModule, CacheModule],
  controllers: [HealthController],
})
export class HealthModule {}

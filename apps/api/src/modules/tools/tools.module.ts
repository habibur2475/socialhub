/**
 * Tools module composition.
 *
 * The module's **client-side tools have no server half**, and that is the design: PDF,
 * QR, calculator, age, budget and the period tracker are compiled into the web bundle and
 * store nothing here. Only notes are wired into Nest, because only notes promise that
 * something written on one device is readable on another.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CLOCK, IDS } from '../auth/auth.tokens.js';
import type { Clock, IdGenerator } from '../auth/application/ports.js';
import { ToolsService } from './application/tools.service.js';
import { PostgresNoteRepository } from './infrastructure/note.repository.js';
import { ToolsController } from './presentation/tools.controller.js';
import { NOTE_STORE, TOOLS_SERVICE } from './tools.tokens.js';
import type { NoteStore } from './application/ports.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ToolsController],
  providers: [
    { provide: NOTE_STORE, useClass: PostgresNoteRepository },
    {
      provide: TOOLS_SERVICE,
      useFactory: (store: NoteStore, ids: IdGenerator, clock: Clock): ToolsService =>
        new ToolsService(store, ids, clock),
      inject: [NOTE_STORE, IDS, CLOCK],
    },
  ],
  exports: [TOOLS_SERVICE],
})
export class ToolsModule {}

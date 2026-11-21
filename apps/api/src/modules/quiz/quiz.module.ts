/**
 * Quiz module composition.
 *
 * The clock is a provider rather than a direct `new Date()` call so that grading a
 * timed attempt is testable at a fixed instant — the same reason the auth module
 * injects one.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CLOCK } from '../auth/auth.tokens.js';
import { IDS } from '../auth/auth.tokens.js';
import type { Clock, IdGenerator } from '../auth/application/ports.js';
import { QuizService } from './application/quiz.service.js';
import { PostgresQuizRepository } from './infrastructure/quiz.repository.js';
import { QuizController } from './presentation/quiz.controller.js';
import { QUIZ_CLOCK, QUIZ_SERVICE, QUIZ_STORE } from './quiz.tokens.js';
import type { QuizStore } from './application/ports.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [QuizController],
  providers: [
    { provide: QUIZ_STORE, useClass: PostgresQuizRepository },
    // Aliased, not re-provided: a second clock provider would be a second source of
    // truth for "now", and the attempt/limit comparison would then be able to
    // disagree with the session expiry it is measured against.
    { provide: QUIZ_CLOCK, useExisting: CLOCK },
    {
      provide: QUIZ_SERVICE,
      useFactory: (sets: QuizStore, ids: IdGenerator, clock: Clock): QuizService =>
        new QuizService(sets, ids, clock),
      inject: [QUIZ_STORE, IDS, QUIZ_CLOCK],
    },
  ],
  exports: [QUIZ_SERVICE],
})
export class QuizModule {}

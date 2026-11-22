/**
 * Work module composition.
 *
 * Three controllers, split by who reads the resource rather than by table: the board (public to
 * every signed-in account), proposals (the freelancer's own, and the client's inbox), and
 * contracts (exactly two people).
 *
 * The four stores and the service are wired through the same tokens the market module uses, so
 * a test can substitute a store without a Nest container — see `work.service.spec.ts`.
 */

import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CLOCK, IDS } from '../auth/auth.tokens.js';
import type { Clock, IdGenerator } from '../auth/application/ports.js';
import { WorkService } from './application/work.service.js';
import type { ContractStore, JobStore, ProposalStore } from './application/ports.js';
import { PostgresJobStore } from './infrastructure/job.repository.js';
import { PostgresProposalStore } from './infrastructure/proposal.repository.js';
import { PostgresContractStore } from './infrastructure/contract.repository.js';
import {
  ContractController,
  JobController,
  ProposalController,
} from './presentation/work.controller.js';
import { CONTRACT_STORE, JOB_STORE, PROPOSAL_STORE, WORK_SERVICE } from './work.tokens.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [JobController, ProposalController, ContractController],
  providers: [
    { provide: JOB_STORE, useClass: PostgresJobStore },
    { provide: PROPOSAL_STORE, useClass: PostgresProposalStore },
    { provide: CONTRACT_STORE, useClass: PostgresContractStore },
    {
      provide: WORK_SERVICE,
      useFactory: (
        jobs: JobStore,
        proposals: ProposalStore,
        contracts: ContractStore,
        ids: IdGenerator,
        clock: Clock,
      ) => new WorkService(jobs, proposals, contracts, ids, clock),
      inject: [JOB_STORE, PROPOSAL_STORE, CONTRACT_STORE, IDS, CLOCK],
    },
  ],
  exports: [WORK_SERVICE],
})
export class WorkModule {}

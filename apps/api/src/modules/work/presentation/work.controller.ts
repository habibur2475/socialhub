/**
 * Work HTTP surface.
 *
 * Two prefixes and one rule: everything here needs a session. A job board is where people
 * publish budgets and where freelancers publish their prices, and there is no version of that
 * which reads well anonymously.
 *
 * The shape follows the market module deliberately, because it is the same kind of resource:
 *
 *   * an `:id` that is not a UUID is a `400` from `ParseUUIDPipe` rather than a Postgres error;
 *   * state changes are a **named action** (`POST /:id/actions`), never a `status` field, so a
 *     client cannot walk a job into a state the state machine forbids;
 *   * a refusal is a `DomainException` with the kernel's own message, so the same sentence
 *     appears in the API, in the UI, and in a test.
 *
 * `GET /jobs/:id/proposals` is the client's inbox and refuses anyone else. The freelancer's own
 * proposal comes back inside `GET /jobs/:id` as `myProposal` — a list of everyone who applied,
 * with their prices, would be a competitor's price list.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { WorkService } from '../application/work.service.js';
import { WORK_SERVICE } from '../work.tokens.js';
import {
  createJobRequestSchema,
  createProposalRequestSchema,
  jobActionRequestSchema,
  jobQuerySchema,
  milestoneActionRequestSchema,
  updateJobRequestSchema,
  type CreateJobDto,
  type CreateProposalDto,
  type JobActionDto,
  type JobQueryDto,
  type MilestoneActionDto,
  type UpdateJobDto,
} from './dto.js';
import type {
  ContractListResponse,
  ContractResponse,
  JobListResponse,
  JobResponse,
  ProposalResponse,
} from '@socialhub/contracts';
import { z } from 'zod';

/** The same decimal-string rule the contracts use, applied to the one hand-parsed field. */
const toMinor = (amount: string): number => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

const contractQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(120).optional(),
  })
  .strict();

const disputeSchema = z.object({ reason: z.string().trim().min(10).max(2_000) }).strict();

const resolveSchema = z
  .object({
    outcome: z.enum(['RELEASED_TO_FREELANCER', 'REFUNDED_TO_CLIENT']),
    /** Optional; when given it must be the amount that goes to the freelancer. */
    toFreelancer: z
      .string()
      .trim()
      .regex(/^\d{1,9}(\.\d{1,2})?$/u)
      .optional(),
  })
  .strict();

@Controller({ path: 'work/jobs', version: '1' })
@UseGuards(AuthGuard)
export class JobController {
  public constructor(@Inject(WORK_SERVICE) private readonly work: WorkService) {}

  @Get()
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(jobQuerySchema)) query: JobQueryDto,
  ): Promise<JobListResponse> {
    return this.work.listJobs(principal.accountId, query);
  }

  @Get(':id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<JobResponse> {
    return this.work.job(principal.accountId, id);
  }

  @Get(':id/proposals')
  public async proposals(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<readonly ProposalResponse[]> {
    return this.work.proposalsForJob(principal.accountId, id);
  }

  @Post()
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createJobRequestSchema)) body: CreateJobDto,
  ): Promise<JobResponse> {
    return this.work.createJob(principal.accountId, body);
  }

  @Patch(':id')
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateJobRequestSchema)) body: UpdateJobDto,
  ): Promise<JobResponse> {
    return this.work.updateJob(principal.accountId, id, body);
  }

  @Post(':id/proposals')
  public async propose(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(createProposalRequestSchema)) body: CreateProposalDto,
  ): Promise<ProposalResponse> {
    return this.work.propose(principal.accountId, id, body);
  }

  @Post(':id/actions')
  @HttpCode(HttpStatus.OK)
  public async act(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(jobActionRequestSchema)) body: JobActionDto,
  ): Promise<JobResponse> {
    const { job } = await this.work.actOnJob(principal.accountId, id, body);
    return job;
  }
}

@Controller({ path: 'work/proposals', version: '1' })
@UseGuards(AuthGuard)
export class ProposalController {
  public constructor(@Inject(WORK_SERVICE) private readonly work: WorkService) {}

  /** Withdrawing is not a `DELETE` of the record: the offer is kept, and its status says so. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async withdraw(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.work.withdrawProposal(principal.accountId, id);
  }
}

@Controller({ path: 'work/contracts', version: '1' })
@UseGuards(AuthGuard)
export class ContractController {
  public constructor(@Inject(WORK_SERVICE) private readonly work: WorkService) {}

  @Get()
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(contractQuerySchema))
    query: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<ContractListResponse> {
    return this.work.listContracts(principal.accountId, query.limit, query.cursor ?? null);
  }

  @Get(':id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContractResponse> {
    return this.work.contract(principal.accountId, id);
  }

  @Post(':id/milestones/:milestoneId/actions')
  @HttpCode(HttpStatus.OK)
  public async milestone(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('milestoneId', new ParseUUIDPipe()) milestoneId: string,
    @Body(new ZodBody(milestoneActionRequestSchema)) body: MilestoneActionDto,
  ): Promise<ContractResponse> {
    return this.work.actOnMilestone(principal.accountId, id, milestoneId, body);
  }

  /**
   * The dispute desk. Refused for ordinary accounts by the service, not by the route, so the
   * same rule applies to anything else that ever calls `resolve`.
   */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  public async resolve(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(resolveSchema))
    body: { outcome: 'RELEASED_TO_FREELANCER' | 'REFUNDED_TO_CLIENT'; toFreelancer?: string },
  ): Promise<ContractResponse> {
    return this.work.resolve(
      principal,
      id,
      body.outcome,
      body.toFreelancer === undefined ? undefined : toMinor(body.toFreelancer),
    );
  }

  /** Either party may open a dispute; it freezes the escrow rather than moving it. */
  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  public async dispute(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(disputeSchema)) body: { readonly reason: string },
  ): Promise<ContractResponse> {
    return this.work.openDispute(principal.accountId, id, body.reason);
  }
}

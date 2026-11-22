/**
 * Work DTOs.
 *
 * The schemas are re-exported from the shared contracts so the server and the browser validate
 * the same shape, and the `*Dto` aliases are the parsed types — a route handler receives what
 * the transform produced, never the raw request.
 */

import {
  createJobRequestSchema,
  createProposalRequestSchema,
  jobActionRequestSchema,
  jobQuerySchema,
  milestoneActionRequestSchema,
  updateJobRequestSchema,
  type CreateJobRequest,
  type CreateProposalRequest,
  type JobActionRequest,
  type JobQuery,
  type MilestoneActionRequest,
  type UpdateJobRequest,
} from '@socialhub/contracts';

export {
  createJobRequestSchema,
  createProposalRequestSchema,
  jobActionRequestSchema,
  jobQuerySchema,
  milestoneActionRequestSchema,
  updateJobRequestSchema,
};

export type CreateJobDto = CreateJobRequest;
export type UpdateJobDto = UpdateJobRequest;
export type CreateProposalDto = CreateProposalRequest;
export type JobActionDto = JobActionRequest;
export type MilestoneActionDto = MilestoneActionRequest;
export type JobQueryDto = JobQuery;

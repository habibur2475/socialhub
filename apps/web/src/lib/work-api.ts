/**
 * Work API bindings.
 *
 * Every state change is a **named action**, so this file has no `setStatus`-shaped method:
 * there is nowhere on the client where a status could be written directly. A button calls
 * `actOnJob` or `actOnMilestone`, and the server decides whether that move is legal.
 *
 * `milestones` is sent with the award, not after it. The plan and the award are one request
 * because they are one decision — the client is agreeing to the payment schedule at the moment
 * they agree to the freelancer.
 */

import type {
  ContractListResponse,
  ContractResponse,
  CreateJobRequestInput,
  CreateProposalRequestInput,
  JobActionRequestInput,
  JobListResponse,
  JobQuery,
  JobResponse,
  MilestoneActionRequest,
  ProposalResponse,
  UpdateJobRequestInput,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

export type WorkApi = {
  jobs(query?: Partial<JobQuery>): Promise<JobListResponse>;
  job(id: string): Promise<JobResponse>;
  createJob(input: CreateJobRequestInput): Promise<JobResponse>;
  updateJob(id: string, input: UpdateJobRequestInput): Promise<JobResponse>;
  proposals(jobId: string): Promise<readonly ProposalResponse[]>;
  propose(
    jobId: string,
    input: Omit<CreateProposalRequestInput, 'deliveryDays'> & {
      readonly deliveryDays: number | string;
    },
  ): Promise<ProposalResponse>;
  withdraw(proposalId: string): Promise<void>;
  /** The *input* shape: milestone amounts are the decimal strings a form produces. */
  actOnJob(id: string, input: JobActionRequestInput): Promise<JobResponse>;
  contracts(query?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<ContractListResponse>;
  contract(id: string): Promise<ContractResponse>;
  actOnMilestone(
    contractId: string,
    milestoneId: string,
    input: MilestoneActionRequest,
  ): Promise<ContractResponse>;
  dispute(contractId: string, reason: string): Promise<ContractResponse>;
};

const base = '/api/v1/work';

const queryString = (query?: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

export const createWorkApi = (client: ApiClient): WorkApi => ({
  jobs: (query) => client.request<JobListResponse>(`${base}/jobs${queryString(query)}`),
  job: (id) => client.request<JobResponse>(`${base}/jobs/${encodeURIComponent(id)}`),
  createJob: (input) =>
    client.request<JobResponse>(`${base}/jobs`, { method: 'POST', body: input }),
  updateJob: (id, input) =>
    client.request<JobResponse>(`${base}/jobs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }),
  proposals: (jobId) =>
    client.request<readonly ProposalResponse[]>(
      `${base}/jobs/${encodeURIComponent(jobId)}/proposals`,
    ),
  propose: (jobId, input) =>
    client.request<ProposalResponse>(`${base}/jobs/${encodeURIComponent(jobId)}/proposals`, {
      method: 'POST',
      body: input,
    }),
  withdraw: (proposalId) =>
    client.request<void>(`${base}/proposals/${encodeURIComponent(proposalId)}`, {
      method: 'DELETE',
    }),
  actOnJob: (id, input) =>
    client.request<JobResponse>(`${base}/jobs/${encodeURIComponent(id)}/actions`, {
      method: 'POST',
      body: input,
    }),
  contracts: (query) =>
    client.request<ContractListResponse>(`${base}/contracts${queryString(query)}`),
  contract: (id) => client.request<ContractResponse>(`${base}/contracts/${encodeURIComponent(id)}`),
  actOnMilestone: (contractId, milestoneId, input) =>
    client.request<ContractResponse>(
      `${base}/contracts/${encodeURIComponent(contractId)}/milestones/${encodeURIComponent(milestoneId)}/actions`,
      { method: 'POST', body: input },
    ),
  dispute: (contractId, reason) =>
    client.request<ContractResponse>(
      `${base}/contracts/${encodeURIComponent(contractId)}/dispute`,
      {
        method: 'POST',
        body: { reason },
      },
    ),
});

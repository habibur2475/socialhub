/**
 * Profile DTOs.
 *
 * Aliases over the shared contracts, not redefinitions. The API validates with
 * exactly the object the browser builds its forms from, so a rule can never be
 * stricter on one side than the other.
 */

import type {
  BlockRequest,
  FollowRequest,
  ListQuery,
  ProfileListResponse,
  ProfileResponse,
  UpdateProfileRequest,
} from '@socialhub/contracts';

export {
  blockRequestSchema,
  followRequestSchema,
  listQuerySchema,
  updateProfileRequestSchema,
} from '@socialhub/contracts';

export type UpdateProfileDto = UpdateProfileRequest;
export type FollowDto = FollowRequest;
export type BlockDto = BlockRequest;
export type ListDto = ListQuery;
export type ProfileDto = ProfileResponse;
export type ProfileListDto = ProfileListResponse;

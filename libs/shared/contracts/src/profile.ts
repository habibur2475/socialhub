/**
 * Profile and social-graph contracts.
 *
 * Shared by the API validator and the web forms, so a rule can only be changed
 * in one place. The bio limit and the display-name pattern are imported from
 * `auth.ts` rather than restated: they are the same platform-wide rules, and a
 * copy would eventually disagree with the database constraint.
 */

import { z } from 'zod';

import { DISPLAY_NAME_PATTERN, USERNAME_PATTERN } from './auth.js';

/** Mirrors the `user_profiles.bio` CHECK constraint. */
export const BIO_MAX_LENGTH = 500;

export const PROFILE_VISIBILITY_VALUES = ['PUBLIC', 'FOLLOWERS', 'PRIVATE'] as const;

export const profileVisibilitySchema = z.enum(PROFILE_VISIBILITY_VALUES);

/**
 * An empty bio is sent as null, not as "": the database stores the absence of a
 * bio as NULL, and treating the two as different would make "clear the bio" and
 * "save an empty bio" behave differently for no reason a user can perceive.
 */
export const bioSchema = z
  .string()
  .trim()
  .max(BIO_MAX_LENGTH, `Bio cannot exceed ${BIO_MAX_LENGTH} characters`)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

export const updateProfileRequestSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .regex(DISPLAY_NAME_PATTERN, 'Display name contains unsupported characters')
      .optional(),
    bio: bioSchema.optional(),
    visibility: profileVisibilitySchema.optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        USERNAME_PATTERN,
        'Username must be 3-30 characters: lowercase letters, digits or underscore',
      )
      .optional(),
  })
  .strict()
  // An empty PATCH is a client bug, not a no-op: it costs a round trip and hides
  // the mistake. Rejecting it surfaces the bug at the first call.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const followRequestSchema = z
  .object({ accountId: z.string().uuid('A valid account id is required') })
  .strict();

export type FollowRequest = z.infer<typeof followRequestSchema>;

export const blockRequestSchema = z
  .object({
    accountId: z.string().uuid('A valid account id is required'),
    reason: z.string().trim().max(280, 'Reason cannot exceed 280 characters').optional(),
  })
  .strict();

export type BlockRequest = z.infer<typeof blockRequestSchema>;

export const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export type ListQuery = z.infer<typeof listQuerySchema>;

/** The public profile shape returned by every profile endpoint. */
export type ProfileResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarKey: string | null;
  readonly bannerKey: string | null;
  readonly followerCount: number | null;
  readonly followingCount: number | null;
  readonly createdAt: string;
  readonly isSelf: boolean;
  readonly isFollowing: boolean;
  readonly followPending: boolean;
  readonly isBlocked: boolean;
  readonly canFollow: boolean;
  readonly canMessage: boolean;
};

export type ProfileSummaryResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly bio: string | null;
};

export type ProfileListResponse = {
  readonly items: readonly ProfileSummaryResponse[];
  readonly nextCursor: string | null;
};

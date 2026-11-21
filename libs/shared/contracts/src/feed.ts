/**
 * Feed contracts.
 *
 * The same schemas validate requests in the API and drive the composer in the
 * browser, so the character limit and the visibility list have exactly one
 * definition. `POST_BODY_MAX_LENGTH` is imported from the kernel rather than
 * restated here for the same reason.
 */

import { z } from 'zod';

import { POST_BODY_MAX_LENGTH } from '@socialhub/kernel/browser';

export const POST_VISIBILITIES = ['PUBLIC', 'FOLLOWERS', 'PRIVATE'] as const;

export const postVisibilitySchema = z.enum(POST_VISIBILITIES);

/**
 * The body is trimmed before validation, so a composer that submits trailing
 * spaces is accepted, while a body of nothing but spaces is rejected.
 *
 * Length is checked with `[...value].length` through a superRefine rather than
 * `.max()`, because `.max()` counts UTF-16 units: it would reject 3000 emoji that
 * the author sees as 3000 characters.
 */
export const createPostRequestSchema = z
  .object({
    body: z.string().trim().min(1, 'Write something first'),
    visibility: postVisibilitySchema.default('PUBLIC'),
    replyTo: z.string().uuid('A valid post id is required').optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ([...value.body].length > POST_BODY_MAX_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'string',
        maximum: POST_BODY_MAX_LENGTH,
        inclusive: true,
        path: ['body'],
        message: `A post cannot exceed ${POST_BODY_MAX_LENGTH} characters`,
      });
    }
  });

export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

export const updatePostRequestSchema = z
  .object({ body: z.string().trim().min(1, 'Write something first') })
  .strict();

export type UpdatePostRequest = z.infer<typeof updatePostRequestSchema>;

/**
 * Timeline query.
 *
 * `cursor` is the last post id of the previous page. Post ids are uuidv7, so
 * ordering by id is ordering by publication time and the cursor needs no second
 * column — which is what makes the index a single-column scan.
 */
export const timelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

/** The shape returned for every post, wherever it appears. */
export type PostResponse = {
  readonly id: string;
  readonly author: {
    readonly accountId: string;
    readonly username: string;
    readonly displayName: string;
    readonly avatarKey: string | null;
  };
  readonly body: string;
  readonly visibility: (typeof POST_VISIBILITIES)[number];
  readonly likeCount: number;
  readonly replyCount: number;
  readonly repostCount: number;
  readonly likedByMe: boolean;
  readonly replyTo: string | null;
  /** Present when this post is a repost: the original, already visibility-checked. */
  readonly repostOf: PostResponse | null;
  readonly editedAt: string | null;
  readonly createdAt: string;
};

export type TimelineResponse = {
  readonly items: readonly PostResponse[];
  readonly nextCursor: string | null;
};

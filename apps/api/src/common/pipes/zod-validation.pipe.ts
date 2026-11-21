/**
 * zod validation pipe.
 *
 * A route declares its schema explicitly:
 *
 *   @Post('login')
 *   login(@Body(new ZodBody(loginSchema)) body: LoginDto) { … }
 *
 * Explicit means what runs in tests is exactly what runs in production, with no
 * dependence on decorator metadata being emitted by whichever tool compiled the
 * code. The pipe is generic, so the handler parameter type is inferred from the
 * schema and the two cannot drift.
 */

import { type ArgumentMetadata, type PipeTransform, Injectable } from '@nestjs/common';
import type { ZodError, ZodTypeAny, output } from 'zod';

import { DomainException } from '../filters/domain-exception.js';
import { appError } from '@socialhub/kernel';

const formatIssues = (error: ZodError): { path: string; message: string }[] =>
  error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

@Injectable()
export class ZodPipe<Schema extends ZodTypeAny> implements PipeTransform<unknown, output<Schema>> {
  public constructor(private readonly schema: Schema) {}

  public transform(value: unknown, _metadata: ArgumentMetadata): output<Schema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new DomainException(
        appError('VALIDATION_FAILED', 'Request validation failed', {
          issues: formatIssues(result.error),
        }),
      );
    }
    return result.data;
  }
}

/** Convenience wrapper so routes read naturally: `new ZodBody(loginSchema)`. */
export class ZodBody<Schema extends ZodTypeAny> extends ZodPipe<Schema> {}

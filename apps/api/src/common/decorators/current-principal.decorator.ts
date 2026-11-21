/**
 * Parameter decorator that hands a handler the authenticated principal.
 *
 * Using a decorator rather than reading `request` in controllers keeps handlers
 * free of transport concerns and makes the dependency on authentication explicit
 * at the type level: if the guard did not run, the parameter is undefined and the
 * type check at the call site catches it.
 */

import { type ExecutionContext, createParamDecorator } from '@nestjs/common';

import type { RequestWithPrincipal } from '../../modules/auth/presentation/auth.guard.js';
import { DomainException } from '../filters/domain-exception.js';
import { appError } from '@socialhub/kernel';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): NonNullable<RequestWithPrincipal['principal']> => {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    if (request.principal === undefined) {
      // Reachable only when a route uses the decorator without the guard, which
      // is a wiring error rather than a user error.
      throw new DomainException(appError('UNAUTHENTICATED', 'Authentication is required'));
    }
    return request.principal;
  },
);

/**
 * Global exception filter.
 *
 * Guarantees, in order of importance:
 *   1. No internal detail escapes. Unknown errors become a generic 500 with a
 *      correlation id; the details go to the log, never to the response.
 *   2. The response shape is constant: `{ error: { code, message, traceId } }`.
 *   3. Every 5xx is logged at error level with the stack; 4xx denials are logged
 *      at info with no stack, because they are normal traffic.
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ErrorCode } from '@socialhub/kernel';

import { DomainException } from './domain-exception.js';
import { statusFor } from '../errors/http-mapping.js';
import { JsonLogger } from '../logging/logger.js';

type ErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly traceId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

const TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  public constructor(private readonly logger: JsonLogger) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    // Honour an inbound correlation id so a client-side report can be joined to
    // the server log line without either side guessing.
    const inbound = request.header('x-request-id');
    const traceId =
      inbound !== undefined && TRACE_ID_PATTERN.test(inbound) ? inbound : randomUUID();

    const translated = this.translate(exception, traceId);

    this.logger.event(translated.logLevel, 'http.error', {
      traceId,
      method: request.method,
      path: request.path,
      status: translated.status,
      // Named `errorCode`, not `code`: the redactor treats `code` as sensitive
      // because it also covers one-time codes.
      errorCode: translated.body.error.code,
      exception:
        exception instanceof Error
          ? { name: exception.name, message: exception.message, stack: exception.stack }
          : exception,
    });

    if (response.headersSent) return;

    response.setHeader('x-request-id', traceId);
    response.status(translated.status).json(translated.body);
  }

  private translate(
    exception: unknown,
    traceId: string,
  ): { status: number; body: ErrorBody; logLevel: 'info' | 'warn' | 'error' } {
    if (exception instanceof DomainException) {
      const error = exception.error;
      return {
        status: statusFor(error.code),
        body: {
          error: {
            code: error.code,
            message: error.message,
            traceId,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        logLevel: error.code === 'INTERNAL_ERROR' ? 'error' : 'info',
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message = extractMessage(payload, exception.message);
      return {
        status,
        body: { error: { code: codeForStatus(status), message, traceId } },
        logLevel: status >= 500 ? 'error' : 'info',
      };
    }

    // Anything here is a bug or an infrastructure fault. The operator gets the
    // detail through logs; the caller gets a correlation id only.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong. Please try again.',
          traceId,
        },
      },
      logLevel: 'error',
    };
  }
}

const extractMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message: unknown }).message;
    if (Array.isArray(message)) return message.map((entry) => String(entry)).join('; ');
    return String(message);
  }
  return fallback;
};

const codeForStatus = (status: number): ErrorCode => {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
  }
};

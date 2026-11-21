/**
 * Notification HTTP surface.
 *
 * Reads are HTTP; delivery is server-sent events at `/notifications/stream`.
 *
 * Why SSE rather than WebSocket: the payload is one-directional, the consumer is a
 * browser tab, and `text/event-stream` reconnects on its own. A WebSocket would add
 * a second authentication path (a browser cannot set an `Authorization` header on
 * the upgrade, so the token ends up in the query string and in every access log), a
 * second proxy configuration, and a ping/pong protocol that reimplements what SSE
 * already provides. When bidirectional real-time arrives with chat, its gateway
 * will sit beside this route and share the same hub.
 *
 * The stream is authenticated like every other route, so the browser reads it with
 * `fetch` and a header rather than with `EventSource` — the token never enters a
 * URL.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type {
  NotificationListResponse,
  NotificationQuery,
  NotificationSummaryResponse,
} from '@socialhub/contracts';
import { notificationQuerySchema } from '@socialhub/contracts';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { NotificationsService } from '../application/notifications.service.js';
import { InProcessRealtimeHub, pipeToSse } from '../infrastructure/realtime-hub.js';
import { NOTIFICATION_SERVICE, REALTIME_HUB } from '../notifications.tokens.js';

/**
 * Heartbeat interval.
 *
 * Comfortably below the 60-second idle timeout that NGINX, most load balancers
 * and many corporate proxies apply. Without it a quiet account's connection is
 * silently reaped and the client keeps a dead socket open.
 */
const HEARTBEAT_MS = 25_000;

@Controller()
@UseGuards(AuthGuard)
export class NotificationsController {
  public constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationsService,
    @Inject(REALTIME_HUB) private readonly hub: InProcessRealtimeHub,
  ) {}

  @Get('notifications')
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(notificationQuerySchema)) query: NotificationQuery,
  ): Promise<NotificationListResponse> {
    return this.notifications.list(principal.accountId, {
      limit: query.limit,
      cursor: query.cursor ?? null,
      unreadOnly: query.unreadOnly,
    });
  }

  /**
   * Declared before `notifications/:id/read` would matter only if it were a POST;
   * it is a GET, so no route conflict exists — but it stays next to `list` because
   * the two are read together by the shell.
   */
  @Get('notifications/summary')
  public async summary(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<NotificationSummaryResponse> {
    return this.notifications.summary(principal.accountId);
  }

  @Post('notifications/read-all')
  @HttpCode(HttpStatus.OK)
  public async markAllRead(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ unreadCount: number }> {
    return this.notifications.markAllRead(principal.accountId);
  }

  @Post('notifications/:id/read')
  @HttpCode(HttpStatus.OK)
  public async markRead(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<{ unreadCount: number }> {
    return this.notifications.markRead(principal.accountId, id);
  }

  /**
   * The live stream.
   *
   * `X-Accel-Buffering: no` disables NGINX response buffering, which would
   * otherwise hold frames until a buffer filled — the classic "works locally, every
   * event arrives thirty seconds late in production" bug. `no-transform` does the
   * same for intermediaries that compress and coalesce.
   */
  @Get('notifications/stream')
  public stream(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Res() response: Response,
    @Req() request: Request,
  ): void {
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    // Idle socket detection: the heartbeat is written every 25s, so a TCP write
    // that has not completed in two minutes means the peer is gone.
    response.setTimeout(120_000);
    response.flushHeaders();

    const opened = this.hub.open(principal.accountId);

    if (opened.overLimit) {
      response.write(
        'event: error\ndata: {"type":"error","code":"TOO_MANY_STREAMS","message":"Too many open streams"}\n\n',
      );
      response.end();
      return;
    }

    const write = (chunk: string): void => {
      if (response.writableEnded) return;
      response.write(chunk);
    };

    // Tells the client the socket is live, and separates "connected" from "the
    // first frame happened to arrive immediately".
    write('event: ready\ndata: {"type":"ready"}\n\n');

    const subscription = pipeToSse(opened.stream, write);
    const heartbeat = setInterval(() => {
      write(`event: ping\ndata: {"type":"ping","at":"${new Date().toISOString()}"}\n\n`);
    }, HEARTBEAT_MS);
    // A heartbeat alone must not keep the process alive during shutdown.
    heartbeat.unref();

    let closed = false;
    const cleanup = (): void => {
      // Both `close` events fire in the normal case; cleanup must be idempotent.
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.unsubscribe();
      opened.release();
    };

    request.on('close', cleanup);
    response.on('close', cleanup);
  }
}

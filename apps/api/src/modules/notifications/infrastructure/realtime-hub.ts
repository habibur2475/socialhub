/**
 * In-process real-time fan-out.
 *
 * One `Subject` per connected recipient, created on the first connection and
 * dropped with the last one. The alternative — a single broadcast subject filtered
 * per subscriber — would wake every connection for every notification in the
 * system, which is exactly the load a chatty platform produces.
 *
 * The hub holds no history. A subscriber that connects after a notification was
 * written reads the inbox over HTTP and then subscribes; the small window in
 * between can miss a frame, and that is the correct trade: an outbox would mean
 * per-recipient replay state and a bounded buffer that is still occasionally too
 * small. The inbox query is the source of truth, the stream is an optimisation.
 *
 * Multi-replica deployment needs a bridge (Redis pub/sub) behind `publish`. The
 * port exists so that change is one adapter, not a refactor of every producer.
 */

import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Subject, type Observable, type Subscription } from 'rxjs';

import { JsonLogger } from '../../../common/logging/logger.js';
import type { RealtimeHub } from '../application/ports.js';

/** Hard ceiling on live connections per recipient. */
const MAX_STREAMS_PER_ACCOUNT = 5;

@Injectable()
export class InProcessRealtimeHub implements RealtimeHub, OnApplicationShutdown {
  private readonly streams = new Map<string, Subject<unknown>>();
  /** Connection count per recipient, so the cap is enforced without subscribing. */
  private readonly connections = new Map<string, number>();

  public constructor(private readonly logger: JsonLogger) {}

  public publish(recipientId: string, frame: unknown): void {
    const subject = this.streams.get(recipientId);
    // Most notifications go to someone who is not connected. That is the normal
    // case, not an error: the inbox is what they will read.
    if (subject === undefined) return;
    subject.next(frame);
  }

  /**
   * Opens a stream for a recipient.
   *
   * The returned `release` must be called on disconnect — it is what drops the
   * subject once the last connection goes, so an offline account costs nothing.
   */
  public open(recipientId: string): {
    readonly stream: Observable<unknown>;
    readonly overLimit: boolean;
    readonly release: () => void;
  } {
    const active = this.connections.get(recipientId) ?? 0;

    if (active >= MAX_STREAMS_PER_ACCOUNT) {
      this.logger.event('warn', 'realtime.too_many_streams', {
        recipientId,
        active,
      });
      // A finished observable closes the response immediately, which the client
      // reads as "too many windows open" rather than a hanging socket.
      return { stream: new Subject<unknown>(), overLimit: true, release: () => undefined };
    }

    let subject = this.streams.get(recipientId);
    if (subject === undefined) {
      subject = new Subject<unknown>();
      this.streams.set(recipientId, subject);
    }

    this.connections.set(recipientId, active + 1);
    const owned = subject;

    return {
      stream: owned.asObservable(),
      overLimit: false,
      release: () => {
        const remaining = (this.connections.get(recipientId) ?? 1) - 1;
        if (remaining <= 0) {
          this.connections.delete(recipientId);
          this.streams.delete(recipientId);
          owned.complete();
          return;
        }
        this.connections.set(recipientId, remaining);
      },
    };
  }

  public onApplicationShutdown(): void {
    for (const subject of this.streams.values()) subject.complete();
    this.streams.clear();
    this.connections.clear();
  }
}

/**
 * Bridges an RxJS stream to a write callback.
 *
 * Kept out of the hub so the hub stays testable without a response object: this is
 * the only place that knows a frame is serialised as a server-sent event.
 */
export const pipeToSse = (
  stream: Observable<unknown>,
  write: (chunk: string) => void,
): Subscription =>
  stream.subscribe({
    next: (frame) => {
      write(`data: ${JSON.stringify(frame)}\n\n`);
    },
    error: () => {
      write('event: error\ndata: {"type":"error"}\n\n');
    },
  });

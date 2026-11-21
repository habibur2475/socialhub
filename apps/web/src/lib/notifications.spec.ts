/**
 * Real-time client tests.
 *
 * The SSE parser is the one piece of the stream that can be tested without a socket,
 * and it is also the piece most likely to be wrong: a frame can be split anywhere,
 * including between two bytes of one character.
 */

import { describe, expect, it } from 'vitest';

import { badgeFor } from '@/lib/notifications';
import { createSseParser } from '@/lib/notifications-api';

describe('the SSE parser', () => {
  it('parses a complete frame', () => {
    const parser = createSseParser();
    const frames = parser.push('event: notification\ndata: {"type":"notification"}\n\n');

    expect(frames).toEqual([{ event: 'notification', data: { type: 'notification' } }]);
    expect(parser.pending()).toBe('');
  });

  it('parses several frames from one chunk', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'event: ready\ndata: {"type":"ready"}\n\nevent: unread\ndata: {"type":"unread","unreadCount":2}\n\n',
    );

    expect(frames.map((frame) => frame.event)).toEqual(['ready', 'unread']);
  });

  /** A frame split across reads is the normal case, not an edge case. */
  it('buffers a frame split across chunks', () => {
    const parser = createSseParser();

    expect(parser.push('event: notification\nda')).toEqual([]);
    expect(parser.pending()).toBe('event: notification\nda');
    expect(parser.push('ta: {"type":"notification"}\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'notification', data: { type: 'notification' } }]);
  });

  it('normalises CRLF line endings from a rewriting proxy', () => {
    const parser = createSseParser();
    const frames = parser.push('event: ping\r\ndata: {"type":"ping"}\r\n\r\n');

    expect(frames).toEqual([{ event: 'ping', data: { type: 'ping' } }]);
  });

  /** One malformed frame must not cost the connection. */
  it('drops a frame whose JSON is invalid and keeps going', () => {
    const parser = createSseParser();
    const frames = parser.push(
      'event: notification\ndata: {not json\n\nevent: ping\ndata: {"type":"ping"}\n\n',
    );

    expect(frames).toEqual([{ event: 'ping', data: { type: 'ping' } }]);
  });

  it('ignores a comment line without inventing a frame', () => {
    const parser = createSseParser();
    // A bare comment frame carries no data, so there is nothing to deliver.
    expect(parser.push(': keep-alive\n\n')).toEqual([]);
  });

  it('joins multiple data lines with a newline', () => {
    const parser = createSseParser();
    const frames = parser.push('event: x\ndata: {"a":\ndata: 1}\n\n');

    expect(frames).toEqual([{ event: 'x', data: { a: 1 } }]);
  });
});

describe('the unread badge', () => {
  it('caps at 99+ so an exact count is not published', () => {
    expect(badgeFor(0)).toBe('0');
    expect(badgeFor(9)).toBe('9');
    expect(badgeFor(99)).toBe('99');
    expect(badgeFor(100)).toBe('99+');
    expect(badgeFor(4_201)).toBe('99+');
  });

  it('never renders a negative count', () => {
    // Defensive: a stream frame arriving out of order must not produce "-1".
    expect(badgeFor(-3)).toBe('0');
  });
});

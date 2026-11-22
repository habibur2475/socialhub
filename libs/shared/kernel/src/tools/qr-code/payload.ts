/**
 * QR payloads.
 *
 * The output here is the **string** a scanner understands, not an image. That split is
 * deliberate: an image cannot be asserted on in a test, and the payload is where every real
 * decision lives — what a `WIFI:` field escapes, whether a `mailto:` query is encoded,
 * which URL schemes are refused.
 *
 * The URL rule matters most. A QR code on a poster is scanned by a phone that will happily
 * open `javascript:`, `file:` or a custom scheme; a tool that encodes whatever was typed is
 * a tool that can be used to hand a stranger's phone an intent they did not ask for. Only
 * `http:` and `https:` are encoded.
 */

import { type Result, fail, ok } from '../../result.js';

export type QrKind = 'URL' | 'TEXT' | 'WIFI' | 'PHONE' | 'EMAIL' | 'SMS' | 'VCARD';

export const QR_KINDS: readonly QrKind[] = [
  'URL',
  'TEXT',
  'WIFI',
  'PHONE',
  'EMAIL',
  'SMS',
  'VCARD',
];

/**
 * The ceiling for encoded content.
 *
 * Version 40 with high error correction holds just under 1.3 kB. Refusing at 1 200
 * characters means "too long" arrives as a message about the content instead of a library
 * exception, and a code dense enough to be unreadable from a phone never gets generated.
 */
export const QR_MAX_LENGTH = 1_200;

export type QrRequest =
  | { readonly kind: 'URL'; readonly url: string }
  | { readonly kind: 'TEXT'; readonly text: string }
  | {
      readonly kind: 'WIFI';
      readonly ssid: string;
      readonly password: string;
      readonly security: 'WPA' | 'WEP' | 'nopass';
      readonly hidden: boolean;
    }
  | { readonly kind: 'PHONE'; readonly phone: string }
  | {
      readonly kind: 'EMAIL';
      readonly address: string;
      readonly subject: string;
      readonly body: string;
    }
  | { readonly kind: 'SMS'; readonly phone: string; readonly message: string }
  | {
      readonly kind: 'VCARD';
      readonly name: string;
      readonly organization: string;
      readonly phone: string;
      readonly email: string;
      readonly url: string;
    };

export type QrError =
  | { readonly code: 'EMPTY_CONTENT' }
  | { readonly code: 'CONTENT_TOO_LONG'; readonly length: number }
  | { readonly code: 'INVALID_URL' }
  | { readonly code: 'INVALID_EMAIL' };

/** Escapes the characters the Wi-Fi payload grammar treats as syntax. */
const escapeWifi = (value: string): string => value.replace(/([\\;,:"])/gu, '\\$1');

/** Escapes the characters the vCard grammar treats as syntax. */
const escapeVcard = (value: string): string =>
  value.replace(/([\\;,])/gu, '\\$1').replace(/\r?\n/gu, '\\n');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const qrPayload = (request: QrRequest): Result<string, QrError> => {
  let payload: string;

  switch (request.kind) {
    case 'URL': {
      const trimmed = request.url.trim();
      if (trimmed === '') return fail({ code: 'EMPTY_CONTENT' });

      let parsed: URL;
      try {
        parsed = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`);
      } catch {
        return fail({ code: 'INVALID_URL' });
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail({ code: 'INVALID_URL' });
      }

      payload = parsed.toString();
      break;
    }

    case 'TEXT':
      payload = request.text;
      break;

    case 'WIFI':
      if (request.ssid.trim() === '') return fail({ code: 'EMPTY_CONTENT' });
      payload =
        `WIFI:T:${request.security};S:${escapeWifi(request.ssid)};` +
        `${request.security === 'nopass' ? '' : `P:${escapeWifi(request.password)};`}` +
        `${request.hidden ? 'H:true;' : ''};`;
      break;

    case 'PHONE':
      if (request.phone.trim() === '') return fail({ code: 'EMPTY_CONTENT' });
      payload = `tel:${request.phone.trim()}`;
      break;

    case 'EMAIL': {
      if (!EMAIL_PATTERN.test(request.address.trim())) return fail({ code: 'INVALID_EMAIL' });
      const query = new URLSearchParams();
      if (request.subject !== '') query.set('subject', request.subject);
      if (request.body !== '') query.set('body', request.body);
      const suffix = query.toString();
      payload = `mailto:${request.address.trim()}${suffix === '' ? '' : `?${suffix}`}`;
      break;
    }

    case 'SMS':
      if (request.phone.trim() === '') return fail({ code: 'EMPTY_CONTENT' });
      payload = `SMSTO:${request.phone.trim()}:${request.message}`;
      break;

    case 'VCARD': {
      if (request.name.trim() === '') return fail({ code: 'EMPTY_CONTENT' });
      // vCard 3.0 is CRLF-terminated by specification; scanners are strict about it.
      payload = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeVcard(request.name)}`,
        `N:${escapeVcard(request.name)};;;;`,
        request.organization === '' ? '' : `ORG:${escapeVcard(request.organization)}`,
        request.phone === '' ? '' : `TEL;TYPE=CELL:${escapeVcard(request.phone)}`,
        request.email === '' ? '' : `EMAIL:${escapeVcard(request.email)}`,
        request.url === '' ? '' : `URL:${escapeVcard(request.url)}`,
        'END:VCARD',
      ]
        .filter((line) => line !== '')
        .join('\r\n');
      break;
    }
  }

  if (payload.trim() === '') return fail({ code: 'EMPTY_CONTENT' });
  if (payload.length > QR_MAX_LENGTH)
    return fail({ code: 'CONTENT_TOO_LONG', length: payload.length });
  return ok(payload);
};

/**
 * Error-correction level.
 *
 * `M` (15%) is the default because a code printed on a poster gets rained on, and `H` (30%)
 * costs a third of the capacity for a screen nobody touches. The user can raise it.
 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

export const QR_ERROR_LEVELS: readonly QrErrorCorrection[] = ['L', 'M', 'Q', 'H'];

/** A filename that is safe on every filesystem and still says what it is. */
export const qrFileName = (kind: QrKind): string => `socialhub-qr-${kind.toLowerCase()}.png`;

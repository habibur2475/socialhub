import { describe, expect, it } from 'vitest';

import { QR_MAX_LENGTH, qrFileName, qrPayload } from './payload.js';

describe('qrPayload', () => {
  it('keeps a URL it was given and adds a scheme when one is missing', () => {
    expect(qrPayload({ kind: 'URL', url: 'https://socialhub.test/blog' })).toEqual({
      ok: true,
      value: 'https://socialhub.test/blog',
    });
    expect(qrPayload({ kind: 'URL', url: 'socialhub.test' })).toEqual({
      ok: true,
      value: 'https://socialhub.test/',
    });
  });

  it('refuses a scheme a scanner would hand to the operating system', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(qrPayload({ kind: 'URL', url })).toEqual({
        ok: false,
        error: { code: 'INVALID_URL' },
      });
    }
  });

  it('escapes the characters the Wi-Fi grammar reserves', () => {
    expect(
      qrPayload({
        kind: 'WIFI',
        ssid: 'Cafe; Bar',
        password: 'pa:ss,word',
        security: 'WPA',
        hidden: false,
      }),
    ).toEqual({ ok: true, value: 'WIFI:T:WPA;S:Cafe\\; Bar;P:pa\\:ss\\,word;;' });
  });

  it('leaves the password out of an open network', () => {
    expect(
      qrPayload({
        kind: 'WIFI',
        ssid: 'Guest',
        password: 'ignored',
        security: 'nopass',
        hidden: true,
      }),
    ).toEqual({ ok: true, value: 'WIFI:T:nopass;S:Guest;H:true;;' });
  });

  it('builds a mailto with an encoded subject and body', () => {
    expect(
      qrPayload({
        kind: 'EMAIL',
        address: 'ada@socialhub.test',
        subject: 'Hello there',
        body: 'A & B',
      }),
    ).toEqual({ ok: true, value: 'mailto:ada@socialhub.test?subject=Hello+there&body=A+%26+B' });
  });

  it('refuses a malformed email address', () => {
    expect(qrPayload({ kind: 'EMAIL', address: 'not-an-email', subject: '', body: '' })).toEqual({
      ok: false,
      error: { code: 'INVALID_EMAIL' },
    });
  });

  it('builds a vCard with CRLF line endings and escaped newlines', () => {
    const payload = qrPayload({
      kind: 'VCARD',
      name: 'Ada Lovelace',
      organization: 'Analytical Engines',
      phone: '+8801700000000',
      email: 'ada@socialhub.test',
      url: 'https://socialhub.test/u/ada',
    });
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      expect(payload.value.split('\r\n')).toEqual([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Ada Lovelace',
        'N:Ada Lovelace;;;;',
        'ORG:Analytical Engines',
        'TEL;TYPE=CELL:+8801700000000',
        'EMAIL:ada@socialhub.test',
        'URL:https://socialhub.test/u/ada',
        'END:VCARD',
      ]);
    }
  });

  it('builds tel and SMS payloads', () => {
    expect(qrPayload({ kind: 'PHONE', phone: '+8801700000000' })).toEqual({
      ok: true,
      value: 'tel:+8801700000000',
    });
    expect(qrPayload({ kind: 'SMS', phone: '+8801700000000', message: 'Hi' })).toEqual({
      ok: true,
      value: 'SMSTO:+8801700000000:Hi',
    });
  });

  it('refuses empty content and content too long for a code', () => {
    expect(qrPayload({ kind: 'TEXT', text: '   ' })).toEqual({
      ok: false,
      error: { code: 'EMPTY_CONTENT' },
    });
    expect(qrPayload({ kind: 'TEXT', text: 'a'.repeat(QR_MAX_LENGTH + 1) })).toEqual({
      ok: false,
      error: { code: 'CONTENT_TOO_LONG', length: QR_MAX_LENGTH + 1 },
    });
  });

  it('names the download after the kind', () => {
    expect(qrFileName('WIFI')).toBe('socialhub-qr-wifi.png');
  });
});

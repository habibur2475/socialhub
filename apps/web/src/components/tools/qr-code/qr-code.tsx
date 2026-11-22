'use client';

/**
 * The QR generator.
 *
 * The panel draws the matrix itself on a `<canvas>`: the payload is decided by the kernel,
 * the encoder is `qrcode-generator` (12 kB, no DOM), and the drawing is twenty lines. A
 * rendering library that returns an `<img>` would be easier and would make the download a
 * data URL — which is exactly the thing that cannot be printed at 300 dpi.
 *
 * The download is a PNG drawn on a fresh canvas at the requested pixel size, in black on
 * white regardless of the theme: a QR code in the app's dark palette does not scan.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Download, Link2, Loader2, QrCode } from 'lucide-react';

import {
  QR_KINDS,
  type QrError,
  type QrKind,
  type QrRequest,
  qrFileName,
  qrPayload,
} from '@socialhub/kernel/browser';

import { ToolField, ToolShell, toolInputClass } from '@/components/tools/tool-shell';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';

const KIND_LABELS: Record<QrKind, string> = {
  URL: 'Link',
  TEXT: 'Text',
  WIFI: 'Wi-Fi',
  PHONE: 'Phone',
  EMAIL: 'Email',
  SMS: 'SMS',
  VCARD: 'Contact',
};

const ERROR_TEXT: Record<QrError['code'], string> = {
  EMPTY_CONTENT: 'Fill in the content first.',
  CONTENT_TOO_LONG: 'That is too much for one code — it would not scan reliably.',
  INVALID_URL: 'That is not a web address. Only http and https are encoded.',
  INVALID_EMAIL: 'That does not look like an email address.',
};

export const QrCodeTool = (): React.JSX.Element => {
  const [kind, setKind] = useState<QrKind>('URL');
  const [url, setUrl] = useState('https://socialhub.test');
  const [text, setText] = useState('');
  const [ssid, setSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [security, setSecurity] = useState<'WPA' | 'WEP' | 'nopass'>('WPA');
  const [hidden, setHidden] = useState(false);
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [subject, setSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [organization, setOrganization] = useState('');
  const [level, setLevel] = useState<'L' | 'M' | 'Q' | 'H'>('M');
  const [size, setSize] = useState(512);
  const [busy, setBusy] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);

  const request: QrRequest = useMemo(() => {
    switch (kind) {
      case 'URL':
        return { kind, url };
      case 'TEXT':
        return { kind, text };
      case 'WIFI':
        return { kind, ssid, password: wifiPassword, security, hidden };
      case 'PHONE':
        return { kind, phone };
      case 'EMAIL':
        return { kind, address, subject, body: emailBody };
      case 'SMS':
        return { kind, phone, message };
      case 'VCARD':
        return { kind, name, organization, phone, email: address, url };
    }
  }, [
    kind,
    url,
    text,
    ssid,
    wifiPassword,
    security,
    hidden,
    phone,
    address,
    subject,
    emailBody,
    message,
    name,
    organization,
  ]);

  const payload = useMemo(() => qrPayload(request), [request]);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || !payload.ok) return;

    try {
      const code = qrcode(0, level);
      code.addData(payload.value);
      code.make();
      const count = code.getModuleCount();

      // 4 modules of quiet zone on every side: a code printed flush to the edge of a page
      // is a code that some scanners refuse.
      const modules = count + 8;
      const scale = Math.max(1, Math.floor(320 / modules));
      element.width = modules * scale;
      element.height = modules * scale;

      const context = element.getContext('2d');
      if (context === null) return;

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, element.width, element.height);
      context.fillStyle = '#000000';

      for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
          if (code.isDark(row, column)) {
            context.fillRect((column + 4) * scale, (row + 4) * scale, scale, scale);
          }
        }
      }
    } catch {
      // The encoder throws when the content is beyond the largest version despite the
      // length guard; the payload message already covers what the person can do about it.
    }
  }, [payload, level]);

  const download = async (): Promise<void> => {
    if (!payload.ok) return;
    setBusy(true);

    try {
      const code = qrcode(0, level);
      code.addData(payload.value);
      code.make();
      const count = code.getModuleCount();
      const modules = count + 8;
      const scale = Math.max(2, Math.ceil(size / modules));

      const output = window.document.createElement('canvas');
      output.width = modules * scale;
      output.height = modules * scale;
      const context = output.getContext('2d');
      if (context === null) return;

      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, output.width, output.height);
      context.fillStyle = '#000000';
      for (let row = 0; row < count; row += 1) {
        for (let column = 0; column < count; column += 1) {
          if (code.isDark(row, column)) {
            context.fillRect((column + 4) * scale, (row + 4) * scale, scale, scale);
          }
        }
      }

      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
      if (blob === null) return;

      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = qrFileName(kind);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolShell
      title="QR code"
      icon={QrCode}
      description="A link, a Wi-Fi network, a contact card, an SMS. The code is drawn here in your browser — the content is never sent anywhere, which matters most for the Wi-Fi password."
      handling="local"
      aside={
        <div className="flex flex-col gap-md rounded-lg border border-border p-md">
          <div className="flex items-center justify-center rounded-lg bg-white p-sm">
            <canvas ref={canvas} aria-label="QR code preview" className="max-w-full" role="img" />
          </div>

          {payload.ok ? (
            <>
              <p className="break-all rounded-md bg-raised p-xs font-mono text-caption text-muted">
                {payload.value}
              </p>
              <p className="text-caption text-muted">{payload.value.length} characters.</p>

              <ToolField
                label="Size"
                htmlFor="qr-size"
                hint={`${size} pixels square, printed on white.`}
              >
                <select
                  id="qr-size"
                  value={size}
                  onChange={(event) => setSize(Number(event.target.value))}
                  className={toolInputClass}
                >
                  <option value={256}>Small — 256 px</option>
                  <option value={512}>Medium — 512 px</option>
                  <option value={1024}>Large — 1024 px</option>
                  <option value={2048}>Print — 2048 px</option>
                </select>
              </ToolField>

              <button
                type="button"
                onClick={() => void download()}
                disabled={busy}
                className={buttonClass('primary', 'md')}
              >
                {busy ? (
                  <Loader2 aria-hidden className="size-4 animate-spin" />
                ) : (
                  <Download aria-hidden className="size-4" />
                )}
                Download PNG
              </button>
            </>
          ) : (
            <p role="alert" className="text-small text-danger">
              {ERROR_TEXT[payload.error.code]}
            </p>
          )}

          <ToolField
            label="Error correction"
            htmlFor="qr-level"
            hint="Higher survives damage and poor printing, at the cost of density."
          >
            <select
              id="qr-level"
              value={level}
              onChange={(event) => setLevel(event.target.value as 'L' | 'M' | 'Q' | 'H')}
              className={toolInputClass}
            >
              <option value="L">Low — 7%</option>
              <option value="M">Medium — 15%</option>
              <option value="Q">Quartile — 25%</option>
              <option value="H">High — 30%</option>
            </select>
          </ToolField>
        </div>
      }
    >
      <div className="flex flex-col gap-md">
        <fieldset className="flex flex-wrap gap-xs">
          <legend className="mb-xs text-small font-medium">What should it contain?</legend>
          {QR_KINDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              aria-pressed={kind === option}
              className={cn(
                'h-9 rounded-full px-sm text-small transition-colors',
                kind === option
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'bg-raised text-muted hover:text-foreground',
              )}
            >
              {KIND_LABELS[option]}
            </button>
          ))}
        </fieldset>

        <div className="flex flex-col gap-md">
          {kind === 'URL' ? (
            <ToolField
              label="Web address"
              htmlFor="qr-url"
              hint="Only http and https: a code should never hand a phone an app it did not ask for."
            >
              <input
                id="qr-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                inputMode="url"
                className={toolInputClass}
              />
            </ToolField>
          ) : null}

          {kind === 'TEXT' ? (
            <ToolField label="Text" htmlFor="qr-text" hint="Up to about 1 200 characters.">
              <textarea
                id="qr-text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={6}
                className={cn(toolInputClass, 'h-auto py-sm')}
              />
            </ToolField>
          ) : null}

          {kind === 'WIFI' ? (
            <div className="grid gap-md sm:grid-cols-2">
              <ToolField label="Network name (SSID)" htmlFor="qr-ssid">
                <input
                  id="qr-ssid"
                  value={ssid}
                  onChange={(event) => setSsid(event.target.value)}
                  className={toolInputClass}
                  autoComplete="off"
                />
              </ToolField>
              <ToolField
                label="Password"
                htmlFor="qr-wifi-password"
                hint="Stays in this browser; it is written into the code, nowhere else."
              >
                <input
                  id="qr-wifi-password"
                  value={wifiPassword}
                  onChange={(event) => setWifiPassword(event.target.value)}
                  className={toolInputClass}
                  autoComplete="off"
                  disabled={security === 'nopass'}
                />
              </ToolField>
              <ToolField label="Security" htmlFor="qr-security">
                <select
                  id="qr-security"
                  value={security}
                  onChange={(event) => setSecurity(event.target.value as 'WPA' | 'WEP' | 'nopass')}
                  className={toolInputClass}
                >
                  <option value="WPA">WPA / WPA2 / WPA3</option>
                  <option value="WEP">WEP (old)</option>
                  <option value="nopass">Open, no password</option>
                </select>
              </ToolField>
              <label className="flex items-center gap-xs self-end pb-sm text-small">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(event) => setHidden(event.target.checked)}
                  className="size-4"
                />
                The network does not broadcast its name
              </label>
            </div>
          ) : null}

          {kind === 'PHONE' || kind === 'SMS' ? (
            <div className="grid gap-md sm:grid-cols-2">
              <ToolField
                label="Phone number"
                htmlFor="qr-phone"
                hint="Include the country code if it is for someone abroad."
              >
                <input
                  id="qr-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  className={toolInputClass}
                />
              </ToolField>
              {kind === 'SMS' ? (
                <ToolField label="Message" htmlFor="qr-message">
                  <input
                    id="qr-message"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    className={toolInputClass}
                  />
                </ToolField>
              ) : null}
            </div>
          ) : null}

          {kind === 'EMAIL' ? (
            <div className="grid gap-md sm:grid-cols-2">
              <ToolField label="Email address" htmlFor="qr-address">
                <input
                  id="qr-address"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  inputMode="email"
                  className={toolInputClass}
                />
              </ToolField>
              <ToolField label="Subject" htmlFor="qr-subject">
                <input
                  id="qr-subject"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  className={toolInputClass}
                />
              </ToolField>
              <div className="sm:col-span-2">
                <ToolField label="Message" htmlFor="qr-email-body">
                  <textarea
                    id="qr-email-body"
                    value={emailBody}
                    onChange={(event) => setEmailBody(event.target.value)}
                    rows={3}
                    className={cn(toolInputClass, 'h-auto py-sm')}
                  />
                </ToolField>
              </div>
            </div>
          ) : null}

          {kind === 'VCARD' ? (
            <div className="grid gap-md sm:grid-cols-2">
              <ToolField label="Name" htmlFor="qr-name">
                <input
                  id="qr-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className={toolInputClass}
                />
              </ToolField>
              <ToolField label="Organization" htmlFor="qr-org">
                <input
                  id="qr-org"
                  value={organization}
                  onChange={(event) => setOrganization(event.target.value)}
                  className={toolInputClass}
                />
              </ToolField>
              <ToolField label="Phone" htmlFor="qr-vcard-phone">
                <input
                  id="qr-vcard-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  className={toolInputClass}
                />
              </ToolField>
              <ToolField label="Email" htmlFor="qr-vcard-email">
                <input
                  id="qr-vcard-email"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  inputMode="email"
                  className={toolInputClass}
                />
              </ToolField>
              <div className="sm:col-span-2">
                <ToolField label="Website" htmlFor="qr-vcard-url">
                  <input
                    id="qr-vcard-url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    inputMode="url"
                    className={toolInputClass}
                  />
                </ToolField>
              </div>
            </div>
          ) : null}
        </div>

        <p className="flex items-start gap-xs rounded-md bg-raised p-sm text-caption text-muted">
          <Link2 aria-hidden className="mt-[2px] size-3 shrink-0" />A Wi-Fi password inside a
          printed code is a password anyone who photographs the poster can join with. Print one for
          guests, not for the network your laptop lives on.
        </p>
      </div>
    </ToolShell>
  );
};

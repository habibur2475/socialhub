/**
 * Development mail transport.
 *
 * Writes the message to the structured log instead of sending it, so local
 * development and integration tests never touch a real inbox. The production
 * adapter (SES/SMTP) implements the same `Mailer` interface; nothing else changes.
 */

import { Inject, Injectable } from '@nestjs/common';

import { JsonLogger } from '../../../common/logging/logger.js';
import type { Mailer, MailMessage } from '../application/ports.js';

@Injectable()
export class LogMailer implements Mailer {
  public constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  public async send(message: MailMessage): Promise<void> {
    this.logger.event('info', 'mail.send', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

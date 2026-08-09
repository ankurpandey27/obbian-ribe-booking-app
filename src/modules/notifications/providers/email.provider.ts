import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SendGrid v3 email provider — single REST call, no SDK.
 * SENDGRID_API_KEY must be present; from-address comes from
 * NOTIFICATIONS_FROM_EMAIL (or falls back to a placeholder that
 * makes the failure explicit rather than silently mailing from
 * an unverified sender).
 */

export class SendGridEmailProvider {
  private readonly logger = new Logger(SendGridEmailProvider.name);
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string | undefined;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('notifications.sendgridApiKey');
    this.fromEmail = config.get<string>('notifications.fromEmail');
  }

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async send(
    toEmail: string,
    subject: string,
    textBody: string,
  ): Promise<void> {
    if (!this.apiKey) {
      this.logger.debug(`[email-skip] no SENDGRID_API_KEY (${subject})`);
      return;
    }
    if (!this.fromEmail) {
      throw new Error(
        'SendGrid configured but NOTIFICATIONS_FROM_EMAIL is missing',
      );
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: this.fromEmail },
        subject,
        content: [{ type: 'text/plain', value: textBody }],
      }),
    });

    if (!res.ok) {
      throw new Error(`SendGrid failed (${res.status}): ${await res.text()}`);
    }
    this.logger.debug(`Email sent to ${toEmail}`);
  }
}

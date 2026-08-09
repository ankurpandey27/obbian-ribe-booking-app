import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SMS providers — shared by OTP dispatch and the notification worker.
 * All providers are thin HTTP clients over global fetch (Node 18+);
 * a missing credential throws a descriptive error so callers can
 * fail soft (log + continue) instead of breaking the flow.
 */

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

export class DevSmsProvider implements SmsProvider {
  private readonly logger = new Logger(DevSmsProvider.name);

  send(phone: string, message: string): Promise<void> {
    this.logger.log(`[dev-sms] → ${phone}: ${message}`);
    return Promise.resolve();
  }
}

export class TwilioSmsProvider implements SmsProvider {
  private readonly logger = new Logger(TwilioSmsProvider.name);

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
  ) {}

  async send(phone: string, message: string): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: phone,
      From: this.fromNumber,
      Body: message,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${this.accountSid}:${this.authToken}`).toString(
            'base64',
          ),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Twilio send failed (${res.status}): ${detail}`);
    }
    this.logger.debug(`Twilio SMS sent to ${phone}`);
  }
}

export class Msg91SmsProvider implements SmsProvider {
  private readonly logger = new Logger(Msg91SmsProvider.name);

  constructor(
    private readonly authKey: string,
    private readonly senderId: string,
  ) {}

  /**
   * MSG91 sendhttp API. NOTE: for India production, DLT-approved
   * templates are mandatory — switch to the v5 flow API
   * (https://control.msg91.com/api/v5/flow/) with your flow_id.
   */
  async send(phone: string, message: string): Promise<void> {
    const url = new URL('https://api.msg91.com/api/sendhttp.php');
    url.searchParams.set('authkey', this.authKey);
    url.searchParams.set('mobiles', phone);
    url.searchParams.set('sender', this.senderId);
    url.searchParams.set('route', '4');
    url.searchParams.set('message', message);

    const res = await fetch(url.toString(), { method: 'GET' });
    const text = await res.text();

    if (!res.ok || !text.includes('type:success')) {
      throw new Error(`MSG91 send failed (${res.status}): ${text}`);
    }
    this.logger.debug(`MSG91 SMS sent to ${phone}`);
  }
}

/** Pick the provider from config (otp.provider: dev | twilio | msg91). */
export function createSmsProvider(config: ConfigService): SmsProvider {
  const provider = config.get<string>('otp.provider', 'dev');

  if (provider === 'dev') return new DevSmsProvider();

  if (provider === 'twilio') {
    const accountSid = config.get<string>('otp.twilioAccountSid');
    const authToken = config.get<string>('otp.twilioAuthToken');
    const fromNumber = config.get<string>('otp.twilioFromNumber');
    if (!accountSid || !authToken || !fromNumber) {
      throw new Error(
        'Twilio SMS provider selected but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER missing',
      );
    }
    return new TwilioSmsProvider(accountSid, authToken, fromNumber);
  }

  if (provider === 'msg91') {
    const authKey = config.get<string>('otp.msg91AuthKey');
    const senderId = config.get<string>('otp.msg91SenderId');
    if (!authKey || !senderId) {
      throw new Error(
        'MSG91 SMS provider selected but MSG91_AUTH_KEY/MSG91_SENDER_ID missing',
      );
    }
    return new Msg91SmsProvider(authKey, senderId);
  }

  throw new Error(`Unknown OTP provider: ${provider} (dev | twilio | msg91)`);
}

/** Shared OTP message template (used by auth flow and worker). */
export function otpMessage(code: string): string {
  return `Your Obbian OTP is ${code}. Valid for 5 minutes. Do not share it with anyone.`;
}

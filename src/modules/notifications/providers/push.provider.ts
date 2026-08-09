import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'crypto';
import { existsSync, readFileSync } from 'fs';

/**
 * FCM HTTP v1 push provider — no SDK, just node crypto + fetch.
 * Reads the Firebase service-account JSON (FCM_SERVICE_ACCOUNT_JSON),
 * mints a short-lived RS256 JWT, exchanges it for an OAuth token and
 * POSTs to the Firebase Cloud Messaging v1 endpoint.
 * Missing/blank credentials → skip silently (dev mode).
 */

interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export class FcmPushProvider {
  private readonly logger = new Logger(FcmPushProvider.name);
  private readonly serviceAccount: ServiceAccount | null;

  constructor(config: ConfigService) {
    const path = config.get<string>('notifications.fcmServiceAccountJson');
    if (!path || !existsSync(path)) {
      this.serviceAccount = null;
      return;
    }
    try {
      this.serviceAccount = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as ServiceAccount;
    } catch (err) {
      this.logger.warn(
        `FCM service account unreadable at ${path}: ${(err as Error).message}`,
      );
      this.serviceAccount = null;
    }
  }

  get enabled(): boolean {
    return this.serviceAccount !== null;
  }

  private async accessToken(): Promise<string> {
    const sa = this.serviceAccount;
    if (!sa?.client_email || !sa.private_key) {
      throw new Error('FCM service account missing client_email/private_key');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
    const assertion = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256')
      .update(assertion)
      .sign(sa.private_key, 'base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${assertion}.${signature}`,
      }),
    });
    const json = (await res.json()) as { access_token?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`FCM token exchange failed (${res.status})`);
    }
    return json.access_token;
  }

  async send(
    deviceToken: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!this.enabled || !this.serviceAccount?.project_id) {
      this.logger.debug(
        `[push-skip] no FCM service account configured (${title})`,
      );
      return;
    }

    const token = await this.accessToken();
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.serviceAccount.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            notification: { title, body },
            data: Object.fromEntries(
              Object.entries(data).map(([k, v]) => [k, String(v)]),
            ),
          },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`FCM send failed (${res.status}): ${await res.text()}`);
    }
    this.logger.debug(`FCM push sent to ${deviceToken}`);
  }
}

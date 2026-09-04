import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB, DrizzleDB } from '../database/drizzle.module';
import { messageCatalog } from '../database/schema';
import { Locale, resolveLocalized } from './locale.utils';

export interface MessageTOptions {
  locale: Locale;
  vars?: Record<string, string | number>;
}

@Injectable()
export class MessageService implements OnModuleInit {
  private readonly logger = new Logger(MessageService.name);
  private cache = new Map<string, Record<string, string>>();

  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCache();
  }

  /** Reload all messages from DB into memory (cheap; called on boot + after writes). */
  async refreshCache(): Promise<void> {
    const rows = await this.db.select().from(messageCatalog);
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.key, row.message ?? {});
    }
    this.logger.log(`loaded ${this.cache.size} message keys`);
  }

  /**
   * Translate a key to the requested locale with {var} interpolation.
   * Falls back through the locale chain, then returns the raw key so a missing
   * string is visible (never empty) in the UI.
   */
  t(key: string, options: MessageTOptions): string {
    const { locale, vars } = options;
    const messages = this.cache.get(key);
    let text = resolveLocalized(messages, locale);

    if (!text) {
      // Fallback: try other locales, then return the raw key
      for (const fb of ['en-IN', 'hi-IN', 'te-IN']) {
        if (fb === locale) continue;
        const fbText = messages?.[fb];
        if (fbText) {
          text = fbText;
          break;
        }
      }
      if (!text) return key; // visible missing-key signal
    }

    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return text;
  }

  /** Get all messages for a scope (admin UI). */
  async getScope(
    scope: string,
  ): Promise<Array<{ key: string; message: Record<string, string> }>> {
    const rows = await this.db
      .select()
      .from(messageCatalog)
      .where(eq(messageCatalog.scope, scope));
    return rows.map((r) => ({ key: r.key, message: r.message ?? {} }));
  }

  /** Get all message keys. */
  async getAll(): Promise<
    Array<{ key: string; scope: string; message: Record<string, string> }>
  > {
    const rows = await this.db.select().from(messageCatalog);
    return rows.map((r) => ({
      key: r.key,
      scope: r.scope,
      message: r.message ?? {},
    }));
  }

  /** Upsert a message (admin). */
  async upsert(
    key: string,
    message: Record<string, string>,
    scope = 'global',
    description?: string,
  ): Promise<void> {
    await this.db
      .insert(messageCatalog)
      .values({ key, scope, message, description })
      .onConflictDoUpdate({
        target: messageCatalog.key,
        set: { message, scope, description, updatedAt: new Date() },
      });
    await this.refreshCache();
  }

  /** Delete a message (admin). */
  async remove(key: string): Promise<void> {
    await this.db.delete(messageCatalog).where(eq(messageCatalog.key, key));
    await this.refreshCache();
  }

  /** Bulk upsert (seed). */
  async bulkUpsert(
    entries: Array<{
      key: string;
      scope?: string;
      message: Record<string, string>;
      description?: string;
    }>,
  ): Promise<void> {
    for (const entry of entries) {
      await this.db
        .insert(messageCatalog)
        .values({
          key: entry.key,
          scope: entry.scope ?? 'global',
          message: entry.message,
          description: entry.description,
        })
        .onConflictDoUpdate({
          target: messageCatalog.key,
          set: {
            message: entry.message,
            scope: entry.scope ?? 'global',
            description: entry.description,
            updatedAt: new Date(),
          },
        });
    }
    await this.refreshCache();
  }
}

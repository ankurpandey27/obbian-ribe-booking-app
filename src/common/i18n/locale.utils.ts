export const SUPPORTED_LOCALES = ['en-IN', 'hi-IN', 'te-IN'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'te-IN'; // Hyderabad launch

/**
 * Resolve the best locale for a request.
 *
 * Priority: explicit param → user profile locale → device/Accept-Language →
 * city default (te-IN for Hyderabad) → hardcoded default.
 *
 * Falls back through te-IN → hi-IN → en-IN so a missing Telugu string still
 * shows Hindi or English rather than a raw key.
 */
export function resolveLocale(
  explicit?: string,
  acceptLanguage?: string,
  userLocale?: string,
): Locale {
  const candidates = [
    explicit,
    userLocale,
    parseAcceptLanguage(acceptLanguage),
    DEFAULT_LOCALE,
  ].filter(Boolean);

  for (const c of candidates) {
    const normalized = normalizeLocale(c);
    if (normalized) return normalized;
  }
  return DEFAULT_LOCALE;
}

function normalizeLocale(raw: string): Locale | null {
  const lower = raw.toLowerCase().replace('_', '-');
  // Exact match
  if (SUPPORTED_LOCALES.includes(lower as Locale)) return lower as Locale;
  // Language-only match (e.g. "te" → "te-IN")
  const lang = lower.split('-')[0];
  const match = SUPPORTED_LOCALES.find((l) => l.startsWith(lang + '-'));
  return match ?? null;
}

function parseAcceptLanguage(header?: string): string | undefined {
  if (!header) return undefined;
  // Take the first language tag
  return header.split(',')[0]?.trim().split(';')[0]?.trim();
}

/**
 * Resolve a localized value from a JSONB locale map with the te→hi→en
 * fallback chain.
 */
export function resolveLocalized(
  map: Record<string, string> | null | undefined,
  locale: Locale,
): string {
  if (!map) return '';
  if (map[locale]) return map[locale];
  // Fallback chain based on requested locale
  const fallback =
    locale === 'te-IN'
      ? ['hi-IN', 'en-IN']
      : locale === 'hi-IN'
        ? ['en-IN']
        : [];
  for (const fb of fallback) {
    if (map[fb]) return map[fb];
  }
  // Last resort: any available value
  return Object.values(map)[0] ?? '';
}

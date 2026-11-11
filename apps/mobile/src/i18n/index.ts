import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { getLocales } from 'expo-localization';
import { LanguageSchema, type ErrorCode, type Language } from '@trailpack/shared';
import cs, { type Dict } from './cs';
import en from './en';
import sk from './sk';
import pl from './pl';
import de from './de';

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every translation key, e.g. `'nav.home'`. Typos are compile errors. */
export type TKey = Leaves<Dict>;
export type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

export const resources = {
  cs: { translation: cs },
  en: { translation: en },
  sk: { translation: sk },
  pl: { translation: pl },
  de: { translation: de },
} as const;

export const LANGUAGE_LABELS: Record<Language, string> = {
  cs: 'Čeština',
  en: 'English',
  sk: 'Slovenčina',
  pl: 'Polski',
  de: 'Deutsch',
};

export const LOCALE_TAGS: Record<Language, string> = { cs: 'cs-CZ', en: 'en-GB', sk: 'sk-SK', pl: 'pl-PL', de: 'de-DE' };

/** Device language if supported, else Czech. */
export function detectDeviceLanguage(): Language {
  try {
    const code = getLocales()[0]?.languageCode ?? 'cs';
    const parsed = LanguageSchema.safeParse(code);
    return parsed.success ? parsed.data : 'cs';
  } catch {
    return 'cs';
  }
}

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: 'cs',
    fallbackLng: 'cs',
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
}

export const i18n = i18next;

export function setLanguage(lang: Language): void {
  if (i18next.language !== lang) void i18next.changeLanguage(lang);
}

/** Non-hook translate (toasts, dialogs triggered outside React). */
export const translate: TFn = (key, vars) => String(i18next.t(key as string, (vars ?? {}) as Record<string, unknown>));

/** Typed translation hook. */
export function useT(): { t: TFn; language: Language; locale: string } {
  const { t, i18n: inst } = useTranslation();
  const language = (LanguageSchema.safeParse(inst.language).data ?? 'cs') as Language;
  return { t: t as unknown as TFn, language, locale: LOCALE_TAGS[language] };
}

const ERROR_CODES: readonly ErrorCode[] = [
  'network', 'offline', 'timeout', 'aborted', 'unauthorized', 'forbidden', 'rate_limited', 'not_configured',
  'invalid_input', 'not_found', 'no_route', 'provider_error', 'parse_error', 'too_large', 'storage_full',
  'permission_denied', 'conflict', 'unsupported', 'budget_exceeded', 'unknown',
];

/** Localised, user-facing message for any thrown value (TrailPackError code aware). */
export function errorMessage(t: TFn, e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
    return t(`errors.${code as ErrorCode}`);
  }
  return t('errors.unknown');
}

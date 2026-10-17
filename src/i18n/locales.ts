export const LOCALES = ['en', 'de', 'da', 'hr', 'sr', 'cs', 'nl', 'fr', 'es', 'ru', 'uk'] as const;
export type Locale = typeof LOCALES[number];
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English', de: 'Deutsch', da: 'Dansk', hr: 'Hrvatski', sr: 'Srpski', cs: 'Čeština',
  nl: 'Nederlands', fr: 'Français', es: 'Español', ru: 'Русский', uk: 'Українська',
};
export function localeFromTag(value: string | null | undefined): Locale | undefined {
  const base = value?.toLowerCase().split(/[-_]/)[0];
  return LOCALES.includes(base as Locale) ? base as Locale : undefined;
}

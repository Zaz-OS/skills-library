import { translations, type Locale } from './translations';

export const locales: Locale[] = ['en', 'pt-br'];
export const defaultLocale: Locale = 'en';

export function getLangFromUrl(url: URL): Locale {
  const [, maybeLang] = url.pathname.split('/');
  if (maybeLang === 'pt-br') return 'pt-br';
  return 'en';
}

export function useTranslations(lang: Locale) {
  return translations[lang];
}

export function getLocalizedPath(path: string, lang: Locale): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (lang === defaultLocale) return clean;
  return `/${lang}${clean}`;
}

export function getAlternateLang(lang: Locale): Locale {
  return lang === 'en' ? 'pt-br' : 'en';
}

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

const STORAGE_KEY = 'capybara-language';

function getInitialLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && ['en', 'zh'].includes(stored)) {
      return stored;
    }
  } catch {
    // localStorage might not be available
  }
  // Detect from browser
  const browserLang = navigator.language || '';
  if (browserLang.startsWith('zh')) {
    return 'zh';
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

/** Persist language choice to localStorage */
export function setLanguage(lang: string): void {
  i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export function getLanguage(): string {
  return i18n.language;
}

export default i18n;

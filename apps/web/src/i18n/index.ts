import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import fr from "./locales/fr.json";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
] as const;

function initialLanguage() {
  try {
    const saved = localStorage.getItem("lang");
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch {}
  return navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(code: string) {
  void i18n.changeLanguage(code);
  document.documentElement.lang = code;
  try {
    localStorage.setItem("lang", code);
  } catch {}
}

document.documentElement.lang = i18n.language;
export default i18n;

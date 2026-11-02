// Interface language. Only presentation is translated: event payloads, amounts,
// hashes and anything that reaches the ledger stay exactly as they were, so the
// chosen language can never change what a record says.

const STORAGE_KEY = "the-black-ledger.language.v1";
export const LANGUAGES = ["es", "en"];

const dictionaries = {
  en: {
    "brand.name": "The Black Ledger",
    "brand.tagline": "Where every debt leaves a trace",
    "brand.home": "The Black Ledger home",
    "shell.localBadge": "LOCAL LEDGER",
    "shell.languageLabel": "Interface language",
    "shell.chambers": "The Chambers",
    "shell.chambersLabel": "Ledger chambers",
    "shell.note": "AI may interpret.<br>People confirm.<br>The ledger calculates.",
    "shell.railFooter": "A private ledger on this device",
    "shell.footerTitle": "THE BLACK LEDGER <b>·</b> AN ACCOUNT OF SHARED THINGS",
    "shell.export": "Export ledger data",
    "nav.home": "The Ledger",
    "nav.home.sub": "Session overview",
    "nav.members": "The Broken Mirror",
    "nav.members.sub": "Those bound by debt",
    "nav.expenses": "The Black Telephone",
    "nav.expenses.sub": "Evidence of spending",
    "nav.history": "Memory Extraction",
    "nav.history.sub": "Events that remain",
    "nav.payments": "The Elixir",
    "nav.payments.sub": "Record a settlement",
    "nav.verdict": "The Verdict",
    "nav.verdict.sub": "How balance is restored",
    "dialog.close": "Close",
    "dialog.eyebrow": "A final entry",
    "dialog.title": "Archive this journey?",
    "dialog.body": "The ledger will become read-only. Its events remain on this device and can still be exported.",
    "dialog.keep": "Keep it open",
    "dialog.seal": "Seal the memory",
    "meta.description": "A surreal shared-expense ledger. Every balance has a record."
  },
  es: {
    "brand.name": "The Black Ledger",
    "brand.tagline": "Donde toda deuda deja rastro",
    "brand.home": "Inicio de The Black Ledger",
    "shell.localBadge": "LIBRO LOCAL",
    "shell.languageLabel": "Idioma de la interfaz",
    "shell.chambers": "Las Cámaras",
    "shell.chambersLabel": "Cámaras del libro",
    "shell.note": "La IA puede interpretar.<br>Las personas confirman.<br>El libro calcula.",
    "shell.railFooter": "Un libro privado en este dispositivo",
    "shell.footerTitle": "THE BLACK LEDGER <b>·</b> UN REGISTRO DE LO COMPARTIDO",
    "shell.export": "Exportar los datos del libro",
    "nav.home": "El Libro",
    "nav.home.sub": "Resumen de la sesión",
    "nav.members": "El Espejo Roto",
    "nav.members.sub": "Atados por la deuda",
    "nav.expenses": "El Teléfono Negro",
    "nav.expenses.sub": "Evidencia del gasto",
    "nav.history": "Extracción de Memoria",
    "nav.history.sub": "Los hechos que quedan",
    "nav.payments": "El Elixir",
    "nav.payments.sub": "Registrar un pago",
    "nav.verdict": "El Veredicto",
    "nav.verdict.sub": "Cómo se restituye el equilibrio",
    "dialog.close": "Cerrar",
    "dialog.eyebrow": "Una última entrada",
    "dialog.title": "¿Archivar este viaje?",
    "dialog.body": "El libro pasará a ser de sólo lectura. Sus hechos quedan en este dispositivo y se pueden seguir exportando.",
    "dialog.keep": "Dejarlo abierto",
    "dialog.seal": "Sellar la memoria",
    "meta.description": "Un libro surrealista de gastos compartidos. Todo saldo tiene su registro."
  }
};

const detect = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.includes(stored)) return stored;
  } catch { /* storage can be unavailable; fall through to the browser's own setting */ }
  const navigatorLanguage = typeof navigator !== "undefined" ? navigator.language ?? "" : "";
  return navigatorLanguage.toLowerCase().startsWith("es") ? "es" : "en";
};

let language = detect();

export const currentLanguage = () => language;

export function setLanguage(next) {
  if (!LANGUAGES.includes(next)) return language;
  language = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* a session that cannot persist still switches for this visit */ }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  return language;
}

// A missing key renders its own name and says so, rather than rendering an empty
// string: an untranslated label is a visible gap, not an invisible one.
export function t(key, vars) {
  const table = dictionaries[language] ?? dictionaries.en;
  let value = table[key];
  if (value === undefined) {
    value = dictionaries.en[key];
    if (value === undefined) {
      console.warn(`[i18n] missing key "${key}" in both languages`);
      return key;
    }
    console.warn(`[i18n] missing "${key}" for ${language}; showing English`);
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

export const translationKeys = () => Object.keys(dictionaries.en);
export const dictionaryFor = (lang) => dictionaries[lang] ?? dictionaries.en;

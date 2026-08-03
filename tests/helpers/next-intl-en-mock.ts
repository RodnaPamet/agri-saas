/**
 * Test mock for `next-intl` that resolves the REAL `messages/en.json`
 * translations, so rendered tests can keep asserting real English copy after a
 * component is localized (rather than raw dotted keys). Handles simple `{var}`
 * interpolation and the one ICU-plural shape the Exchange uses.
 *
 * Usage in a rendered test:
 *   jest.mock('next-intl', () => require('../helpers/next-intl-en-mock'));
 */
const en = require('../../messages/en.json') as Record<string, unknown>;

function lookup(ns: string, key: string): string {
    const parts = `${ns}.${key}`.split('.');
    let cur: unknown = en;
    for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
    return typeof cur === 'string' ? cur : `${ns}.${key}`;
}

function interpolate(str: string, vals?: Record<string, unknown>): string {
    if (!vals) return str;
    // {count, plural, one {# offer} other {# offers}}
    str = str.replace(
        /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
        (_m, name: string, one: string, other: string) => {
            const n = vals[name];
            const form = n === 1 ? one : other;
            return form.replace(/#/g, String(n));
        },
    );
    // Simple {var}
    str = str.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vals ? String(vals[k]) : `{${k}}`));
    return str;
}

function makeT(ns: string) {
    const t = (key: string, vals?: Record<string, unknown>) => interpolate(lookup(ns, key), vals);
    t.has = () => true;
    t.rich = (key: string) => lookup(ns, key);
    t.markup = (key: string) => lookup(ns, key);
    t.raw = (key: string) => lookup(ns, key);
    return t;
}

module.exports = {
    __esModule: true,
    useTranslations: (ns: string) => makeT(ns),
    useLocale: () => 'en',
    useFormatter: () => ({
        number: (v: unknown) => String(v),
        dateTime: (v: unknown) => String(v),
        relativeTime: (v: unknown) => String(v),
    }),
};

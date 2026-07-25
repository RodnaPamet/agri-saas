/**
 * GAP-19 — i18n locale completeness guardrail.
 *
 * Locks in the invariant that every locale under `messages/` has
 * exactly the same keyset as `messages/en.json` (the canonical
 * source of truth) AND that interpolation placeholders match per
 * key. Drift accumulates fast in i18n — a feature ships in English,
 * the translator pass slips, the UI silently falls back to the key
 * name in production. This test catches that at PR-review time.
 *
 * Three failure modes covered:
 *
 *   • MISSING — key exists in `en.json` but not in another locale.
 *     The most common drift mode and the one a feature PR is most
 *     likely to introduce.
 *
 *   • ORPHAN — key exists in another locale but not in `en.json`.
 *     Usually a stale rename: someone refactored an English key
 *     and left the old one in the translation file.
 *
 *   • PLACEHOLDER DRIFT — the same key holds different `{var}`
 *     tokens between locales (e.g. en uses `{count}`, bg uses
 *     `{number}`). next-intl will silently fail to interpolate
 *     when the placeholders disagree, leaving raw `{count}` in
 *     the rendered output. Catch it here.
 *
 * Output is actionable: every failure block lists the offending
 * keys grouped by their top-level namespace, with the English
 * source value beside them so a translator can act without opening
 * the JSON file.
 *
 * Companion CLI: `node scripts/i18n-diff.mjs --check` runs the
 * same checks from a developer shell. The TS guardrail and the
 * script duplicate the flatten + diff logic (~20 lines) by design
 * — the script is a Node-native CLI for developers, the test is a
 * Jest module-graph node. Sharing across the boundary would force
 * either tsx-loading from a script or .mjs-importing from Jest;
 * neither is worth the win for a logic block this small.
 */
import * as fs from 'fs';
import * as path from 'path';

const MESSAGES_DIR = path.resolve(__dirname, '../../messages');

type LocaleMap = Map<string, unknown>;

function flatten(obj: Record<string, unknown>, prefix = ''): LocaleMap {
    const out: LocaleMap = new Map();
    for (const [k, v] of Object.entries(obj)) {
        const dotted = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [kk, vv] of flatten(v as Record<string, unknown>, dotted)) {
                out.set(kk, vv);
            }
        } else {
            out.set(dotted, v);
        }
    }
    return out;
}

function placeholders(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    // ICU/next-intl placeholders: {name}, {count, plural, ...}.
    // We only care about the variable name (first capture group),
    // not the formatting tail — same behaviour matters across
    // locales regardless of plural rules.
    return [...value.matchAll(/\{([a-zA-Z0-9_]+)/g)].map((m) => m[1]).sort();
}

function readLocale(name: string): LocaleMap {
    const p = path.join(MESSAGES_DIR, `${name}.json`);
    return flatten(JSON.parse(fs.readFileSync(p, 'utf-8')));
}

// ─── Untranslated-copy detection (English pasted into bg.json) ───
//
// Key-parity can't tell a real translation from an English value copied into
// the locale as a placeholder. A value byte-identical to en is "untranslated
// copy" — UNLESS it's legitimately identical across locales. Those legit
// categories (symbols, numbers, ICU-only strings, ALL-CAPS acronyms/enums,
// short code tokens, brand/product names, email/domain placeholders) are
// encoded in `looksTranslatable`; the small tail that slips through is listed
// explicitly in `UNTRANSLATED_ALLOWLIST` with a reason.
const BRAND =
    /\b(Agrent|Inflect|Microsoft|Entra|SharePoint|Google|Azure|SAML|OAuth|SCIM|SSO|SOC|NIS2|ISO|GDPR|HIPAA|PCI|Markdown|JSON|CSV|PDF|WYSIWYG|SWR|ALE|ROI|API|URL|Bow-Tie|Esc|IdP)\b/;

/** True when a value is real prose that SHOULD differ between en and bg —
 *  i.e. NOT a symbol / number / ICU-only / acronym / code token / brand. */
function looksTranslatable(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const s = value.replace(/\{[^}]*\}/g, '').trim(); // drop ICU placeholders
    if (s.length < 4) return false;
    if (!/[a-z]/.test(s)) return false; // symbols, digits, ICU-only, ALL-CAPS enums
    if (!/\s/.test(s) && s.length < 12) return false; // single short word / token / label
    if (BRAND.test(value)) return false; // product names / proper nouns
    if (/@|\b\w+\.(com|io|app|bg|org)\b/.test(value)) return false; // email / domain placeholders
    return true;
}

/** Values legitimately identical to English despite reading like prose. Each
 *  needs a reason; a new entry means "yes, this really is the same in bg". */
const UNTRANSLATED_ALLOWLIST = new Map<string, string>([
    // SSO/SAML config field labels — kept in English to match the IdP console.
    ['admin.entra.directoryIdLabel', 'Entra console field label, kept in English'],
    ['admin.entra.clientIdLabel', 'Entra console field label, kept in English'],
    ['admin.sso.clientId', 'IdP field label, kept in English'],
    ['admin.sso.clientSecret', 'IdP field label, kept in English'],
    ['admin.sso.idpEntityId', 'IdP field label, kept in English'],
    // Code / technical example placeholders (not natural-language copy).
    ['admin.sso.certificatePlaceholder', 'X.509 cert example — technical, identical across locales'],
    ['admin.sso.clientIdPlaceholder', 'code-token example placeholder'],
    ['admin.sso.clientSecretPlaceholder', 'code-token example placeholder'],
    ['admin.sso.scopesPlaceholder', 'OAuth scope tokens — not translatable'],
    ['org.newTenant.namePlaceholder', 'proper-noun example placeholder'],
    // Deliberately bilingual (BG / EN) headings.
    ['exchange.client.heading', 'deliberately bilingual: "Борса / Exchange"'],
    ['locations.spray.techniqueLabel', 'deliberately bilingual heading (BG / EN)'],
    // Units / example content already locale-neutral or in Bulgarian.
    ['grain.yield.colTPerHa', 'unit "t / ha" — identical across locales'],
]);

/**
 * Group dotted keys by their top-level segment ("common", "risks",
 * "ui", ...) for readable error output. Within each group the keys
 * are sorted alphabetically.
 */
function groupByNamespace(keys: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const k of keys.sort()) {
        const ns = k.split('.', 1)[0];
        const arr = grouped.get(ns) ?? [];
        arr.push(k);
        grouped.set(ns, arr);
    }
    return grouped;
}

function formatMissing(
    missing: string[],
    en: LocaleMap,
    headline: string,
): string {
    if (missing.length === 0) return '';
    const lines = ['', headline, ''];
    const grouped = groupByNamespace(missing);
    for (const [ns, keys] of [...grouped.entries()].sort()) {
        lines.push(`  [${ns}]`);
        for (const k of keys) {
            const enVal = en.get(k);
            const display =
                typeof enVal === 'string'
                    ? enVal.length > 80
                        ? enVal.slice(0, 80) + '…'
                        : enVal
                    : JSON.stringify(enVal);
            lines.push(`    ${k}    en="${display}"`);
        }
    }
    return lines.join('\n');
}

function formatOrphan(orphan: string[], localeName: string, locale: LocaleMap): string {
    if (orphan.length === 0) return '';
    const lines = ['', `  ORPHAN keys in ${localeName}.json (absent from en.json — usually a stale rename):`, ''];
    const grouped = groupByNamespace(orphan);
    for (const [ns, keys] of [...grouped.entries()].sort()) {
        lines.push(`  [${ns}]`);
        for (const k of keys) {
            const v = locale.get(k);
            const display = typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : JSON.stringify(v);
            lines.push(`    ${k}    ${localeName}="${display}"`);
        }
    }
    return lines.join('\n');
}

function formatDrift(
    drift: { key: string; en: string[]; locale: string[] }[],
    localeName: string,
): string {
    if (drift.length === 0) return '';
    const lines = ['', `  PLACEHOLDER DRIFT (same key, different {var} tokens between en and ${localeName}):`, ''];
    for (const d of drift) {
        lines.push(`    ${d.key}    en=[${d.en.join(', ')}]   ${localeName}=[${d.locale.join(', ')}]`);
    }
    return lines.join('\n');
}

// ─── Locale enumeration ─────────────────────────────────────────

const localeFiles = fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'en.json')
    .map((f) => path.basename(f, '.json'));

// Sanity: there is at least one non-en locale to compare against.
// If a future change drops bg.json without adding another locale,
// this fails — that's the right signal because we'd otherwise be
// running a no-op guardrail.
describe('GAP-19 — i18n completeness', () => {
    it('messages/ contains at least one non-English locale to compare', () => {
        expect(localeFiles.length).toBeGreaterThan(0);
    });

    const en = readLocale('en');

    for (const localeName of localeFiles) {
        describe(`${localeName}.json vs en.json`, () => {
            const locale = readLocale(localeName);
            const enKeys = new Set(en.keys());
            const localeKeys = new Set(locale.keys());

            it('has no keys missing from en (every en key is translated)', () => {
                const missing = [...enKeys].filter((k) => !localeKeys.has(k));
                if (missing.length > 0) {
                    throw new Error(
                        `${localeName}.json is missing ${missing.length} translation(s) present in en.json:` +
                            formatMissing(
                                missing,
                                en,
                                `  Add these to messages/${localeName}.json (preserve nesting + interpolation placeholders):`,
                            ) +
                            `\n\nRun \`node scripts/i18n-diff.mjs\` for the same report from a developer shell.`,
                    );
                }
            });

            it('has no orphan keys (every locale key is also in en)', () => {
                const orphan = [...localeKeys].filter((k) => !enKeys.has(k));
                if (orphan.length > 0) {
                    throw new Error(
                        `${localeName}.json has ${orphan.length} orphan key(s) absent from en.json:` +
                            formatOrphan(orphan, localeName, locale) +
                            `\n\nThe English key was likely renamed without updating ${localeName}.json. ` +
                            `Either add the renamed key to en.json, or delete the orphan from ${localeName}.json.`,
                    );
                }
            });

            it('preserves interpolation placeholders across locales', () => {
                const drift: { key: string; en: string[]; locale: string[] }[] = [];
                for (const k of enKeys) {
                    if (!localeKeys.has(k)) continue;
                    const enP = placeholders(en.get(k));
                    const lcP = placeholders(locale.get(k));
                    if (enP.join(',') !== lcP.join(',')) {
                        drift.push({ key: k, en: enP, locale: lcP });
                    }
                }
                if (drift.length > 0) {
                    throw new Error(
                        `${localeName}.json has ${drift.length} key(s) with mismatched {var} placeholders:` +
                            formatDrift(drift, localeName) +
                            `\n\nnext-intl silently fails to interpolate when placeholders disagree, ` +
                            `leaving raw "{var}" tokens in the rendered output. ` +
                            `Update the locale's value to use the same placeholder names as en.json.`,
                    );
                }
            });

            it('has no untranslated copy (English value pasted into the locale)', () => {
                const offenders: string[] = [];
                for (const k of enKeys) {
                    if (!localeKeys.has(k)) continue;
                    const enV = en.get(k);
                    const lcV = locale.get(k);
                    if (typeof enV === 'string' && enV === lcV && looksTranslatable(enV) && !UNTRANSLATED_ALLOWLIST.has(k)) {
                        offenders.push(`    ${k}    "${enV.length > 70 ? enV.slice(0, 70) + '…' : enV}"`);
                    }
                }
                if (offenders.length > 0) {
                    throw new Error(
                        `${localeName}.json has ${offenders.length} untranslated value(s) — English copied verbatim ` +
                            `instead of translated (key-parity is blind to this):\n\n${offenders.join('\n')}\n\n` +
                            `Translate these in messages/${localeName}.json. If a value is legitimately identical ` +
                            `across locales (brand, unit, deliberately bilingual), add its key to ` +
                            `UNTRANSLATED_ALLOWLIST in this file with a written reason.`,
                    );
                }
            });
        });
    }
});

// ─── Self-test: prove the diff detector actually fires ──────────
//
// Without this block, a future regression that breaks the
// flatten/compare logic would let bad locales slip through with
// the test silently still "passing". The self-test runs the same
// flatten + comparison against an in-memory mismatched pair and
// asserts the detection is real.
describe('GAP-19 — i18n completeness self-test', () => {
    const fakeEn = flatten({
        common: { save: 'Save', cancel: 'Cancel' },
        risks: { score: 'Score', count: '{count} risks' },
    } as Record<string, unknown>);

    it('detects MISSING when locale lacks an en key', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази' /* cancel intentionally absent */ },
            risks: { score: 'Резултат', count: '{count} риска' },
        } as Record<string, unknown>);
        const missing = [...fakeEn.keys()].filter((k) => !fakeLocale.has(k));
        expect(missing).toEqual(['common.cancel']);
    });

    it('detects ORPHAN when locale carries a non-en key', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази', cancel: 'Отказ', orphan: 'X' },
            risks: { score: 'Резултат', count: '{count} риска' },
        } as Record<string, unknown>);
        const orphan = [...fakeLocale.keys()].filter((k) => !fakeEn.has(k));
        expect(orphan).toEqual(['common.orphan']);
    });

    it('detects PLACEHOLDER DRIFT when same key uses different {var}', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази', cancel: 'Отказ' },
            risks: { score: 'Резултат', count: '{number} риска' /* drift */ },
        } as Record<string, unknown>);
        const enP = placeholders(fakeEn.get('risks.count'));
        const lcP = placeholders(fakeLocale.get('risks.count'));
        expect(enP).toEqual(['count']);
        expect(lcP).toEqual(['number']);
        expect(enP.join(',')).not.toEqual(lcP.join(','));
    });

    it('placeholder extraction tolerates ICU formatting tail', () => {
        // {count, plural, one {# risk} other {# risks}} — only the
        // var name matters; the formatting tail is locale-specific
        // and intentionally ignored by the comparison.
        const both = '{count, plural, one {# risk} other {# risks}}';
        expect(placeholders(both)).toEqual(['count']);
    });

    it('untranslated detector flags real prose but not symbols/acronyms/brand', () => {
        expect(looksTranslatable('Save your changes before leaving')).toBe(true);
        expect(looksTranslatable('The offer was withdrawn')).toBe(true);
        // legitimately-identical categories are NOT flagged:
        expect(looksTranslatable('SOC 2')).toBe(false); // brand/standard
        expect(looksTranslatable('ALE')).toBe(false); // acronym
        expect(looksTranslatable('{pct}%')).toBe(false); // ICU-only
        expect(looksTranslatable('noreply@inflect.app')).toBe(false); // email
        expect(looksTranslatable('OK')).toBe(false); // short token
        // Note: prose-like exceptions the heuristic can't classify (units like
        // "t / ha", deliberately-bilingual headings) are handled by
        // UNTRANSLATED_ALLOWLIST, not by looksTranslatable.
    });
});

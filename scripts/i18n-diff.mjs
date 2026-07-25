#!/usr/bin/env node
/**
 * GAP-19 — i18n locale key-set reconciler.
 *
 * Flattens `messages/<locale>.json` to a sorted list of dotted keys
 * (e.g. `common.actions`, `risks.heatmap`, `task.severity.HIGH`) and
 * diffs every locale against `messages/en.json`. Reports:
 *
 *   • keys present in English but missing in the locale (must add)
 *   • keys present in the locale but missing in English (orphan,
 *     usually a stale rename — flag for review)
 *   • interpolation drift: same key, different `{var}` placeholders
 *     between locales (e.g. en uses `{count}`, bg uses `{number}`)
 *
 * Run:
 *
 *   node scripts/i18n-diff.mjs                        # report all locales
 *   node scripts/i18n-diff.mjs --check                # exit non-zero on any drift
 *   node scripts/i18n-diff.mjs --locale bg            # only bg vs en
 *
 * Exits 1 with a concrete list when drift is detected, 0 when clean.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const MESSAGES_DIR = resolve(import.meta.dirname, '..', 'messages');

function flatten(obj, prefix = '') {
    const out = new Map();
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [kk, vv] of flatten(v, path)) out.set(kk, vv);
        } else {
            out.set(path, v);
        }
    }
    return out;
}

function placeholders(value) {
    if (typeof value !== 'string') return [];
    // ICU/next-intl style: {name}, {count, plural, ...}
    return [...value.matchAll(/\{([a-zA-Z0-9_]+)/g)].map((m) => m[1]).sort();
}

// Untranslated-copy detection — keep in sync with
// tests/guardrails/i18n-completeness.test.ts (the Jest guard). A locale value
// byte-identical to en is untranslated UNLESS it's legitimately identical
// (symbol/number/ICU-only/acronym/token/brand/email) or explicitly allowlisted.
const BRAND =
    /\b(Agrent|Inflect|Microsoft|Entra|SharePoint|Google|Azure|SAML|OAuth|SCIM|SSO|SOC|NIS2|ISO|GDPR|HIPAA|PCI|Markdown|JSON|CSV|PDF|WYSIWYG|SWR|ALE|ROI|API|URL|Bow-Tie|Esc|IdP)\b/;

function looksTranslatable(value) {
    if (typeof value !== 'string') return false;
    const s = value.replace(/\{[^}]*\}/g, '').trim();
    if (s.length < 4) return false;
    if (!/[a-z]/.test(s)) return false;
    if (!/\s/.test(s) && s.length < 12) return false;
    if (BRAND.test(value)) return false;
    if (/@|\b\w+\.(com|io|app|bg|org)\b/.test(value)) return false;
    return true;
}

const UNTRANSLATED_ALLOWLIST = new Set([
    'admin.entra.directoryIdLabel', 'admin.entra.clientIdLabel', 'admin.sso.clientId',
    'admin.sso.clientSecret', 'admin.sso.idpEntityId', 'admin.sso.clientIdPlaceholder',
    'admin.sso.clientSecretPlaceholder', 'admin.sso.scopesPlaceholder', 'admin.sso.certificatePlaceholder',
    'org.newTenant.namePlaceholder',
    'exchange.client.heading', 'locations.spray.techniqueLabel', 'grain.yield.colTPerHa',
]);

function readLocale(name) {
    const path = resolve(MESSAGES_DIR, `${name}.json`);
    return flatten(JSON.parse(readFileSync(path, 'utf-8')));
}

function diffLocale(en, locale, localeName) {
    const enKeys = new Set(en.keys());
    const localeKeys = new Set(locale.keys());

    const missing = [...enKeys].filter((k) => !localeKeys.has(k)).sort();
    const orphan = [...localeKeys].filter((k) => !enKeys.has(k)).sort();

    const placeholderDrift = [];
    const untranslated = [];
    for (const k of enKeys) {
        if (!localeKeys.has(k)) continue;
        const enP = placeholders(en.get(k));
        const lcP = placeholders(locale.get(k));
        if (enP.join(',') !== lcP.join(',')) {
            placeholderDrift.push({ key: k, en: enP, [localeName]: lcP });
        }
        const enV = en.get(k);
        if (typeof enV === 'string' && enV === locale.get(k) && looksTranslatable(enV) && !UNTRANSLATED_ALLOWLIST.has(k)) {
            untranslated.push(k);
        }
    }

    return { missing, orphan, placeholderDrift, untranslated };
}

function main() {
    const args = new Set(process.argv.slice(2));
    const checkMode = args.has('--check');
    const localeArg = process.argv.indexOf('--locale');
    const onlyLocale = localeArg !== -1 ? process.argv[localeArg + 1] : null;

    const en = readLocale('en');
    const localeFiles = readdirSync(MESSAGES_DIR)
        .filter((f) => f.endsWith('.json') && f !== 'en.json')
        .map((f) => basename(f, '.json'))
        .filter((name) => !onlyLocale || name === onlyLocale);

    let totalMissing = 0;
    let totalOrphan = 0;
    let totalDrift = 0;
    let totalUntranslated = 0;
    const lines = [];

    for (const locale of localeFiles) {
        const map = readLocale(locale);
        const { missing, orphan, placeholderDrift, untranslated } = diffLocale(en, map, locale);

        lines.push('');
        lines.push(`── ${locale}.json vs en.json ──`);
        lines.push(`  en keys      : ${en.size}`);
        lines.push(`  ${locale} keys    : ${map.size}`);
        lines.push(`  missing      : ${missing.length}`);
        lines.push(`  orphan       : ${orphan.length}`);
        lines.push(`  drift        : ${placeholderDrift.length}`);
        lines.push(`  untranslated : ${untranslated.length}`);

        if (missing.length) {
            lines.push('');
            lines.push(`  MISSING in ${locale}.json (present in en, absent in ${locale}):`);
            for (const k of missing) lines.push(`    + ${k}    en="${truncate(en.get(k))}"`);
        }
        if (orphan.length) {
            lines.push('');
            lines.push(`  ORPHAN in ${locale}.json (present in ${locale}, absent in en):`);
            for (const k of orphan) lines.push(`    - ${k}    ${locale}="${truncate(map.get(k))}"`);
        }
        if (placeholderDrift.length) {
            lines.push('');
            lines.push(`  PLACEHOLDER DRIFT (same key, different {var} placeholders):`);
            for (const d of placeholderDrift) {
                lines.push(
                    `    ! ${d.key}    en=[${d.en.join(', ')}]   ${locale}=[${d[locale].join(', ')}]`,
                );
            }
        }

        if (untranslated.length) {
            lines.push('');
            lines.push(`  UNTRANSLATED in ${locale}.json (English value copied verbatim, not translated):`);
            for (const k of untranslated) lines.push(`    = ${k}    "${truncate(en.get(k))}"`);
        }

        totalMissing += missing.length;
        totalOrphan += orphan.length;
        totalDrift += placeholderDrift.length;
        totalUntranslated += untranslated.length;
    }

    const summary = `\n${'='.repeat(60)}\nTOTAL: missing=${totalMissing} orphan=${totalOrphan} drift=${totalDrift} untranslated=${totalUntranslated}\n${'='.repeat(60)}`;

    process.stdout.write(lines.join('\n') + summary + '\n');

    if (checkMode && (totalMissing + totalOrphan + totalDrift + totalUntranslated) > 0) {
        process.exit(1);
    }
}

function truncate(v) {
    if (typeof v !== 'string') return JSON.stringify(v);
    return v.length > 60 ? v.slice(0, 60) + '…' : v;
}

main();

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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

/** The bundle label for a catalogue that is still ONE file per locale. */
const SINGLE_BUNDLE = '(whole catalogue)';

const UNTRANSLATED_ALLOWLIST = new Set([
    'admin.entra.directoryIdLabel', 'admin.entra.clientIdLabel', 'admin.sso.clientId',
    'admin.sso.clientSecret', 'admin.sso.idpEntityId', 'admin.sso.clientIdPlaceholder',
    'admin.sso.clientSecretPlaceholder', 'admin.sso.scopesPlaceholder', 'admin.sso.certificatePlaceholder',
    'org.newTenant.namePlaceholder',
    'grain.yield.colTPerHa',
]);

/**
 * Read one locale's catalogue, whether it is a single file or N bundles.
 *
 * Returns the flattened keys AND where each top-level namespace was found,
 * because the second half is what makes a split checkable at all (#1813).
 *
 * ## The failure a per-file check cannot see
 *
 * #1813 warns that "a per-file check that passes while a key moved between
 * files would be exactly the kind of gate that reports a pass over a
 * population it no longer covers". The sharpest form of that is subtler than
 * a lost key:
 *
 *     messages/bg/app.json      { errors: {...} }
 *     messages/en/shared.json   { errors: {...} }
 *
 * Both files are internally valid. Both locales have the IDENTICAL key union,
 * so a union comparison passes too. Only asking WHERE each namespace lives,
 * and comparing that across locales, catches it — and it matters because the
 * loader picks bundles by name, so one locale would load `errors` and the
 * other would not.
 *
 * So `location` is returned beside the keys, and `main()` asserts three things
 * a single-file catalogue gets for free: no namespace in two bundles, the same
 * namespace in the same bundle in every locale, and the union unchanged.
 */
function readLocale(name) {
    const single = resolve(MESSAGES_DIR, `${name}.json`);
    if (existsSync(single)) {
        const parsed = JSON.parse(readFileSync(single, 'utf-8'));
        // The BUNDLE label, not the filename. `en.json` and `bg.json` differ by
        // construction, so comparing filenames across locales reports every
        // namespace as misfiled — which is what the first version of this did.
        // An unsplit catalogue is one bundle, and both locales must agree that
        // it is the same one.
        const location = new Map(Object.keys(parsed).map((ns) => [ns, SINGLE_BUNDLE]));
        return { flat: flatten(parsed), location, duplicates: [] };
    }

    const dir = resolve(MESSAGES_DIR, name);
    if (!existsSync(dir)) {
        throw new Error(`locale ${name}: neither ${name}.json nor ${name}/ exists`);
    }

    const flat = new Map();
    const location = new Map();
    const duplicates = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
        const parsed = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
        for (const ns of Object.keys(parsed)) {
            const already = location.get(ns);
            if (already) {
                // A namespace in TWO bundles. The merge order would silently
                // pick one, so the other file's keys become unreachable copies
                // that still pass every per-file check.
                duplicates.push({ namespace: ns, files: [already, basename(file, '.json')] });
                continue;
            }
            location.set(ns, basename(file, '.json'));
        }
        for (const [k, v] of flatten(parsed)) flat.set(k, v);
    }
    return { flat, location, duplicates };
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

    const enCat = readLocale('en');
    const en = enCat.flat;
    /**
     * Locales, whether each is stored as `<locale>.json` or `<locale>/*.json`.
     *
     * A bundled locale is a DIRECTORY, so the old `.endsWith('.json')` filter
     * would have skipped it entirely — and skipping a locale means every
     * comparison below runs over one fewer catalogue and still reports
     * `missing=0`. The split would have silenced the check that is supposed to
     * police it.
     */
    const localeNames = readdirSync(MESSAGES_DIR)
        .map((entry) => {
            const full = resolve(MESSAGES_DIR, entry);
            if (entry.endsWith('.json')) return basename(entry, '.json');
            return statSync(full).isDirectory() ? entry : null;
        })
        .filter((name) => name && name !== 'en')
        .filter((name) => !onlyLocale || name === onlyLocale);

    const localeFiles = localeNames;

    let totalMissing = 0;
    let totalOrphan = 0;
    let totalDrift = 0;
    let totalUntranslated = 0;
    let totalDuplicated = 0;
    let totalMisfiled = 0;
    const lines = [];

    for (const locale of localeFiles) {
        const cat = readLocale(locale);
        const map = cat.flat;
        const { missing, orphan, placeholderDrift, untranslated } = diffLocale(en, map, locale);

        // ── structural checks a single file got for free (#1813) ──
        //
        // A namespace in two bundles of ONE locale: the merge picks one and
        // the other file's keys are unreachable duplicates that still pass
        // every per-file check.
        const duplicates = [...cat.duplicates, ...enCat.duplicates];
        // The same namespace filed in DIFFERENT bundles across locales. Both
        // catalogues are internally valid and their key unions are identical,
        // so nothing else here can see it — but the loader selects bundles by
        // name, so one locale would load the namespace and the other would
        // not.
        const misfiled = [];
        for (const [ns, file] of cat.location) {
            const enFile = enCat.location.get(ns);
            if (enFile && enFile !== file) misfiled.push({ namespace: ns, en: enFile, [locale]: file });
        }

        lines.push('');
        lines.push(`── ${locale} vs en ──`);
        lines.push(`  en keys      : ${en.size}`);
        lines.push(`  ${locale} keys    : ${map.size}`);
        lines.push(`  bundles      : en=${new Set(enCat.location.values()).size} ${locale}=${new Set(cat.location.values()).size}`);
        lines.push(`  missing      : ${missing.length}`);
        lines.push(`  orphan       : ${orphan.length}`);
        lines.push(`  drift        : ${placeholderDrift.length}`);
        lines.push(`  untranslated : ${untranslated.length}`);
        lines.push(`  duplicated   : ${duplicates.length}`);
        lines.push(`  misfiled     : ${misfiled.length}`);

        if (duplicates.length) {
            lines.push('');
            lines.push('  DUPLICATED namespace (present in two bundles of one locale):');
            for (const d of duplicates) lines.push(`    * ${d.namespace}    in ${d.files.join(' and ')}`);
        }
        if (misfiled.length) {
            lines.push('');
            lines.push('  MISFILED namespace (same namespace, different bundle per locale):');
            for (const m of misfiled) lines.push(`    ? ${m.namespace}    en=${m.en}  ${locale}=${m[locale]}`);
        }
        totalDuplicated += duplicates.length;
        totalMisfiled += misfiled.length;

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

    const summary = `\n${'='.repeat(60)}\nTOTAL: missing=${totalMissing} orphan=${totalOrphan} drift=${totalDrift} untranslated=${totalUntranslated} duplicated=${totalDuplicated} misfiled=${totalMisfiled}\n${'='.repeat(60)}`;

    process.stdout.write(lines.join('\n') + summary + '\n');

    if (
        checkMode &&
        totalMissing + totalOrphan + totalDrift + totalUntranslated + totalDuplicated + totalMisfiled >
            0
    ) {
        process.exit(1);
    }
}

function truncate(v) {
    if (typeof v !== 'string') return JSON.stringify(v);
    return v.length > 60 ? v.slice(0, 60) + '…' : v;
}

main();

/**
 * Bulgarian catalogue MUST be Cyrillic — "no English in bg.json" ratchet.
 *
 * The parity guard (`i18n-completeness.test.ts`) catches MISSING keys and
 * values pasted byte-identical to English. But it deliberately skips SHORT
 * single-word labels ("Save", "Filter", "Columns") to avoid false positives on
 * brands/acronyms — exactly the class of untranslated UI label a user notices
 * first. This ratchet closes that gap with a script-based signal instead of a
 * copy-comparison one: Bulgarian is written in CYRILLIC, so a `bg.json` value
 * that is PURE LATIN (no Cyrillic at all) after stripping ICU scaffolding,
 * placeholders, brand/acronym tokens and ALL-CAPS enums is untranslated
 * English — regardless of whether it happens to match the English source.
 *
 * Deliberately NARROW to keep it zero-false-positive and forever-green once
 * clean. It only flags values with NO Cyrillic whatsoever; a Bulgarian
 * sentence that embeds a proper noun or unit ("напр. John Deere 6155R",
 * "PDF, Office, CSV") is NOT flagged — mixed prose is real translation. What
 * it catches is the pure-English leaf: `"Save"`, `"Farm Tasks"`, `"In Progress"`.
 *
 * Legitimately-Latin values (brand/acronym-only strings, code/email/URL
 * example placeholders, plan tiers, IdP console field labels kept in English)
 * are excluded by construction (token allow-set) or listed by key in
 * `LATIN_KEY_ALLOWLIST` with a reason. A new entry means "yes, this bg value
 * really is Latin on purpose".
 */
import * as fs from 'fs';
import * as path from 'path';

const BG = path.resolve(__dirname, '../../messages/bg.json');

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
    for (const [k, v] of Object.entries(obj)) {
        const dotted = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, dotted, out);
        else out.set(dotted, v);
    }
    return out;
}

/** Strip ICU scaffolding so only the human-readable copy remains for the
 *  Cyrillic test. The plural/select keywords (`plural`, `one`, `other`, …) and
 *  arg names are Latin SYNTAX, not copy, and must not count as English. */
function stripIcu(s: string): string {
    return s
        .replace(/\{\s*[a-zA-Z0-9_]+\s*,\s*(?:plural|select|selectordinal)\s*,/g, ' ')
        .replace(/\b(?:one|two|few|many|zero|other)\s*\{/g, '{')
        .replace(/=\d+\s*\{/g, '{')
        .replace(/\{[a-zA-Z0-9_]+\}/g, ' ')
        .replace(/[{}#]/g, ' ');
}

/** Latin tokens that are NOT English copy: brands, product names, standards,
 *  acronyms, units. A value made only of these (+ symbols) is never flagged. */
const TOKEN =
    /^(Agrent|Inflect|Meteobot|SoilGrids|ISRIC|USDA|Sentinel|Copernicus|Microsoft|Google|Azure|Entra|SharePoint|Markdown|OAuth|SAML|SCIM|SSO|IdP|SOC|NIS2?|ISO|GDPR|HIPAA|PCI|DSS|WYSIWYG|SWR|DevTools|ALE|LEF|FAIR|ROI|VaR|GDD|SLA|NDVI|NDMI|GPS|API|URL|URI|HTTPS?|PDF|CSV|XLSX|PPTX|JSON|GeoJSON|BGN|EUR|USD|CO2|pH|ha|Bow|Tie|Esc|IP|ID|TLS|BG|EU|v\d[\d.]*)$/i;

function isEmailOrUrl(v: string): boolean {
    return /@|\b[\w-]+\.(com|io|app|bg|org|net|eu)\b|https?:\/\//.test(v);
}
function isAllCaps(w: string): boolean {
    return /^[A-Z0-9]+$/.test(w);
}

/** bg values that are Latin ON PURPOSE. Each needs a reason. */
const LATIN_KEY_ALLOWLIST = new Map<string, string>([
    ['admin.billing.pro', 'billing plan tier — product name kept in English'],
    ['admin.billing.enterprise', 'billing plan tier — product name kept in English'],
    ['admin.entra.directoryIdLabel', 'Entra console field label — kept in English to match the console'],
    ['admin.entra.clientIdLabel', 'Entra console field label — kept in English to match the console'],
    ['admin.sso.clientId', 'IdP console field label — kept in English'],
    ['admin.sso.clientIdPlaceholder', 'code-token example placeholder'],
    ['admin.sso.clientSecret', 'IdP console field label — kept in English'],
    ['admin.sso.clientSecretPlaceholder', 'code-token example placeholder'],
    ['admin.sso.scopesPlaceholder', 'OAuth scope tokens — not translatable'],
    ['admin.sso.idpEntityId', 'IdP console field label — kept in English'],
    ['admin.sso.certificatePlaceholder', 'X.509 cert example placeholder — technical, not translatable'],
    ['admin.sso.nameIdFormatPlaceholder', 'SAML NameID URN example — technical, not translatable'],
    ['environmentBadge.staging', 'deploy-environment name — canonical English label'],
    ['environmentBadge.dev', 'deploy-environment name — canonical English label'],
    ['backNav.soa', 'SoA — Statement of Applicability, standard compliance acronym'],
    ['org.newTenant.namePlaceholder', 'proper-noun example placeholder'],
    ['org.newTenant.slugPlaceholder', 'slug example placeholder (url-safe latin by definition)'],
]);

/** Does a bg value contain untranslated English (pure-Latin, no Cyrillic)? */
export function findLatinCopy(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    const text = stripIcu(value);
    if (/[Ѐ-ӿ]/.test(text)) return []; // has Cyrillic → real (possibly mixed) translation
    if (isEmailOrUrl(value)) return []; // email / domain / URL example placeholder
    return (text.match(/[A-Za-z]{2,}/g) || []).filter((w) => !TOKEN.test(w) && !isAllCaps(w));
}

describe('i18n — bg.json is Bulgarian (Cyrillic), not English', () => {
    const bg = flatten(JSON.parse(fs.readFileSync(BG, 'utf-8')));

    it('control: flatten yields the whole catalogue, not an empty map', () => {
        // The detector self-tests below are thorough and prove `findLatinCopy`
        // fires in both directions — but they call it DIRECTLY, so they stay
        // green no matter what the ratchet actually iterates.
        //
        // The ratchet itself is `for (const [key, value] of bg)`. An empty
        // `bg` runs that loop zero times, collects no offenders, and passes:
        // `selector-teeth` (#971) confirmed `flatten` survives being gutted to
        // `[]`, `''`, `new Set()` and `new Map()`. A catalogue ratchet that
        // checks nothing is worse than none, because the green is taken as
        // evidence that bg.json is clean.
        //
        // Measured: 5446 leaf keys, all nested, under 75 top-level namespaces.
        // The floor is deliberately far below that — this asserts "a real
        // catalogue", not a key count that every translation PR must bump.
        expect(bg.size).toBeGreaterThan(1000);

        // It must also FLATTEN. Returning the top level unflattened would
        // clear the size floor while leaving 75 object values that
        // `findLatinCopy` cannot meaningfully read.
        const dotted = [...bg.keys()].filter((k) => k.includes('.'));
        expect(dotted.length).toBeGreaterThan(1000);

        // And every value must be a LEAF: an object here means the recursion
        // stopped early, which would silently shrink the scanned population.
        const objectValued = [...bg.entries()].filter(
            ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v),
        );
        expect(objectValued).toEqual([]);
    });

    it('has no pure-English (Latin-only) values outside the allow-list', () => {
        const offenders: string[] = [];
        for (const [key, value] of bg) {
            if (LATIN_KEY_ALLOWLIST.has(key)) continue;
            const latin = findLatinCopy(value);
            if (latin.length > 0) offenders.push(`    ${key}    "${value}"   [English: ${latin.join(', ')}]`);
        }
        if (offenders.length > 0) {
            throw new Error(
                `messages/bg.json has ${offenders.length} untranslated (pure-English) value(s):\n\n` +
                    offenders.join('\n') +
                    `\n\nWrite these in Bulgarian (Cyrillic). If a value is legitimately Latin ` +
                    `(brand, acronym, code/email placeholder, deploy-env name), add its key to ` +
                    `LATIN_KEY_ALLOWLIST in this file with a written reason.`,
            );
        }
    });
});

// ─── Self-test: prove the detector fires and is well-behaved ───────────────
describe('bg-cyrillic detector self-test', () => {
    it('flags a pure-English value', () => {
        expect(findLatinCopy('Farm Tasks').length).toBeGreaterThan(0);
        expect(findLatinCopy('In Progress').length).toBeGreaterThan(0);
        expect(findLatinCopy('Save')).toEqual(['Save']);
    });
    it('does NOT flag a Bulgarian value', () => {
        expect(findLatinCopy('Запази промените')).toEqual([]);
        expect(findLatinCopy('Табло')).toEqual([]);
    });
    it('does NOT flag Bulgarian prose with an embedded proper noun / unit', () => {
        expect(findLatinCopy('напр. John Deere 6155R')).toEqual([]);
        expect(findLatinCopy('PDF, Office, CSV — до {mb} MB')).toEqual([]);
    });
    it('does NOT flag brand/acronym-only, ICU-only, ALL-CAPS enums, or placeholders', () => {
        expect(findLatinCopy('SOC 2')).toEqual([]);
        expect(findLatinCopy('PDF')).toEqual([]);
        expect(findLatinCopy('{count, plural, one {# риск} other {# риска}}')).toEqual([]);
        expect(findLatinCopy('ACCEPT → ACCEPTED')).toEqual([]);
        expect(findLatinCopy('noreply@inflect.app')).toEqual([]);
    });
});

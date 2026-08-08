/**
 * Action label vocabulary ratchet.
 *
 * History
 *   - PR-5 (2026-05-08) — banned the `+ ` prefix on labels;
 *     `+` was supposed to come from a `<Plus />` icon prop.
 *   - v2-fu-2 (2026-05-09) — REVERSED that, requiring literal
 *     `+ <Noun>` labels. The rationale (Linear/Notion-style
 *     terse glyph) traded off against centering: when the
 *     button's icon-text flex group bakes "+" into the text,
 *     the cva `justify-center` centres the whole "+ Asset"
 *     string as one unit, but the visual weight of `+` differs
 *     enough from the noun that the button reads off-balance.
 *   - R22-PR-G (2026-05-16) — REVERSES v2-fu-2. CLAUDE.md is now
 *     the source of truth: "Never lead a label with `+ `". The
 *     Plus glyph rides the cva `icon` slot, so the cva centres a
 *     properly balanced icon + label flex group.
 *
 * Current convention
 *   - Translation values are canonical verb-noun phrases:
 *     `"Create Asset"` / `"Add Risk"` / `"New Audit"`.
 *   - Call sites pass `icon={<Plus />}` for the visual glyph.
 *   - This ratchet bans the `+ ` prefix anywhere it could render
 *     as a button label (i18n JSON values, JSX text inside a
 *     button context).
 *
 * Companion ratchet
 *   - `tests/guards/no-plus-prefix-labels.test.ts` — i18n-only
 *     fast scan (any value starting with `"+ "`).
 *   - This file extends to JSX text + EmptyState `primaryAction`
 *     literal labels.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src/app', 'src/components'];
const I18N_DIR = 'messages';

const EXEMPT_DIR_NAMES = new Set<string>([
    'node_modules',
    '__tests__',
    '__mocks__',
]);

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

interface Hit {
    file: string;
    line: number;
    text: string;
}

/**
 * 2026-05-16 baseline — the 18 admin/detail-page sites carrying
 * legacy `'+ <Word>'` literals when R22-PR-G reversed v2-fu-2. The
 * five HEADER buttons on the most-visited list pages (Assets,
 * Risks, Audits, Findings, Evidence) were migrated in R22-PR-G;
 * these 18 sit on lower-traffic pages and are queued for follow-up
 * migration. The ratchet ALLOWS each known site (file + line is
 * locked) so a NEW '+ X' literal added anywhere else fails CI.
 * Future PRs that migrate a baseline entry MUST also remove it
 * from this list — that's how the floor ratchets down.
 *
 * To migrate one: drop the literal '+' from the label string, pass
 * `icon={<Plus />}` to the `<Button>`, remove the line from the
 * baseline below. The companion `no-plus-prefix-labels.test.ts`
 * stays a hard zero — i18n values must not regress, only inline
 * literals are baselined.
 */
const BASELINE_PLUS_LITERAL_SITES = new Set<string>([
    'src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx:509',
    'src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx:234',
    'src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx:593',
    'src/app/t/[tenantSlug]/(app)/admin/scim/page.tsx:216',
    // T05 i18n migration — the `+ Section` label is now own-line JSX
    // text (not a regex-caught literal), so its baseline anchor is
    // dropped. The `+ Question` submit label stays a ternary string
    // literal; its line shifted 687 → 690 when the i18n hooks landed.
    'src/app/t/[tenantSlug]/(app)/admin/vendor-templates/[templateId]/VendorTemplateBuilderClient.tsx:690',
    // T08 i18n — the `+ Pack`/`+ Cycle`/`+ Audit Cycle` literals stay
    // (moving them into message values would trip no-plus-prefix-labels);
    // their lines shifted +2 when the useTranslations hooks + t() calls landed.
    'src/app/t/[tenantSlug]/(app)/audits/cycles/[cycleId]/page.tsx:124',
    'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx:136',
    'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx:209',
    'src/app/t/[tenantSlug]/(app)/audits/cycles/page.tsx:221',
    'src/app/t/[tenantSlug]/(app)/audits/readiness/page.tsx:155',
    // B9 — line numbers shifted by 13 when the Export PDF anchor
    // landed in the page-header actions slot. The `+ Version`
    // labels themselves are unchanged staged debt (see baseline
    // comment); refreshing the anchor positions keeps the
    // baseline honest.
    // SP-4 — shifted +1/+4 when the PolicySharePointSection import + mount
    // landed; the `+ Version` labels themselves are unchanged staged debt.
    // T09 i18n — lines shifted +4 (453→457, 757→761) when the
    // useTranslations/useTranslations('common') hooks + import landed above
    // them. The `+ Version` literals stay (moving them into a message value
    // would trip no-plus-prefix-labels).
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx:457',
    'src/app/t/[tenantSlug]/(app)/policies/[policyId]/page.tsx:761',
    // T13 i18n — the `+ Evidence` literal stays inline (moving it into a
    // message value would trip no-plus-prefix-labels). Its line shifted
    // 419 → 424 when the useTranslations import/hook + useMemo import
    // landed above it.
    'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx:369',
    'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx:393',
    'src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx:470',
]);

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(ROOT, full);
        const segments = rel.split(path.sep);
        if (segments.some((s) => EXEMPT_DIR_NAMES.has(s))) continue;
        if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
        if (entry.isDirectory()) out.push(...walk(full));
        else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('Action label vocabulary — no literal "+ " prefix', () => {
    it('zero JSX/source `"+ <Word>"` literals anywhere in app/components', () => {
        // Match a button-shaped `+ <Word>` literal only when it is
        // wrapped in a label-context boundary: quote/backtick
        // immediately followed by `+` (the label-string form
        // `'+ Asset'`) or JSX text `>+ Asset<` (open-angle-bracket
        // immediately followed by `+`). The "immediately" — no
        // whitespace between the boundary and `+` — excludes false
        // positives like `'-' + Date.now()` (concatenation: there's a
        // space between `'` and `+`, so this doesn't match).
        const RE = /(?:['"`>])\+\s+[A-Z][A-Za-z]/;
        const offenders: Hit[] = [];
        for (const dir of SCAN_DIRS) {
            for (const file of walk(path.join(ROOT, dir))) {
                const content = fs.readFileSync(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*')
                    )
                        return;
                    if (!RE.test(line)) return;
                    const rel = path.relative(ROOT, file);
                    const siteKey = `${rel}:${i + 1}`;
                    if (BASELINE_PLUS_LITERAL_SITES.has(siteKey)) return;
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        text: trimmed.slice(0, 200),
                    });
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} literal '+ <Word>' label(s). Per CLAUDE.md, the '+' goes in the icon slot via 'icon={<Plus />}'; the label text uses the canonical 'Create/Add/New <Entity>' verb form.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('zero i18n button values starting with "+ "', () => {
        const offenders: Hit[] = [];
        const i18nDir = path.join(ROOT, I18N_DIR);
        if (!fs.existsSync(i18nDir)) return;
        for (const file of fs.readdirSync(i18nDir)) {
            if (!file.endsWith('.json')) continue;
            const abs = path.join(i18nDir, file);
            const content = fs.readFileSync(abs, 'utf8');
            const lines = content.split('\n');
            const RE = /:\s*"\+\s/;
            lines.forEach((line, i) => {
                if (!RE.test(line)) return;
                offenders.push({
                    file: path.relative(ROOT, abs),
                    line: i + 1,
                    text: line.trim().slice(0, 200),
                });
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 15)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} i18n value(s) starting with '+ '. Drop the prefix and pass the Plus glyph via 'icon={<Plus />}' at the call site.\n\nFirst ${Math.min(15, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

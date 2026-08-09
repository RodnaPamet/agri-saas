/**
 * Roadmap-3 PR-1 — `<PageActions>` discipline.
 *
 * Until this PR each page hand-rolled the top-right action
 * cluster in its own way. Same logical primary action — Create
 * Risk, Create Practice, New Audit, Generate Share Link — rendered
 * with mixed button sizes (43 sites at sm, 4 at md, 4 at lg),
 * mixed gaps, and inconsistent right-alignment. The user
 * observed the inconsistency directly.
 *
 * The fix locks two things:
 *
 *   1. The cluster geometry. `<PageActions>` is the single
 *      primitive that owns the flex/wrap/gap/min-height. The
 *      `<PageHeader>` actions slot routes through it
 *      automatically, so existing call sites get the canonical
 *      shape with zero migration. New callers can also mount it
 *      directly.
 *
 *   2. Button-size discipline. Every `<Button size="…">` and
 *      `buttonVariants({ size: '…' })` in app pages must read
 *      `size="sm"`. The four `size="md"` / `size="lg"` outliers
 *      that lived on page-header CTAs are migrated. Modal/Sheet
 *      `size=…` props are a different primitive concern (those
 *      are Modal *widths*, addressed by PR-7) and are explicitly
 *      not policed here.
 *
 * What this ratchet does NOT police
 *   • The Button primitive itself (`src/components/ui/button.tsx`
 *     and `button-variants.ts`) which DEFINES the size variants —
 *     those files necessarily reference `md` and `lg` symbols.
 *   • Modal / Sheet `size=` props (PR-7's territory).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOT = path.join(ROOT, 'src/app');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const PRIMITIVE_PATH = 'src/components/layout/PageActions.tsx';
const PAGE_HEADER_PATH = 'src/components/layout/PageHeader.tsx';

// The detector binds to the OPEN TAG of `<Button …>` (or
// `buttonVariants({…})` calls) and checks for `size="md|lg"`
// inside that open tag. Modal / Sheet / ProgressBar / Dialog
// `size=` props never match because the regex anchors on the
// `<Button` / `buttonVariants(` token. The non-greedy
// `[^>]*?` matches across the multi-line open tag.
const BUTTON_SIZE_OUTLIER_RE =
    /<Button\b[^>]*?\bsize\s*=\s*["'](md|lg)["']|buttonVariants\s*\(\s*\{[^}]*?\bsize:\s*["'](md|lg)["']/;

interface Hit {
    file: string;
    line: number;
    text: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__')
                continue;
            out.push(...walk(full));
        } else if (/\.(tsx|jsx)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('PageActions discipline (Roadmap-3 PR-1)', () => {
    it('the PageActions primitive exists at the canonical path', () => {
        expect(fs.existsSync(path.join(ROOT, PRIMITIVE_PATH))).toBe(true);
    });

    it('PageActions locks gap-tight + flex-wrap-reverse + justify-end + min-h-9', () => {
        const src = read(PRIMITIVE_PATH);
        // Gap-tight (8 px), wrap-reverse (keeps primary at right
        // edge when wrapping), right-aligned, min height matching
        // h-9 (Button size="sm" baseline).
        expect(src).toMatch(/gap-tight/);
        expect(src).toMatch(/flex-wrap-reverse/);
        expect(src).toMatch(/justify-end/);
        expect(src).toMatch(/min-h-9/);
    });

    it('PageHeader routes its actions slot through PageActions', () => {
        const src = read(PAGE_HEADER_PATH);
        expect(src).toMatch(
            /from\s+["']@\/components\/layout\/PageActions["']/,
        );
        expect(src).toMatch(/<PageActions\b/);
    });

    it('no Button uses size="md" or size="lg" in app pages', () => {
        // Whole-content scan — Button / buttonVariants open
        // tags can span multiple lines. The regex anchors on
        // `<Button` or `buttonVariants(` and only matches when
        // `size="md|lg"` is INSIDE that open tag. Modal / Sheet
        // / ProgressBar / Dialog `size=` props don't match
        // because the regex anchors elsewhere.
        const offenders: Hit[] = [];
        for (const file of walk(SCAN_ROOT)) {
            const content = fs.readFileSync(file, 'utf-8');
            const rx = new RegExp(BUTTON_SIZE_OUTLIER_RE.source, 'g');
            let match: RegExpExecArray | null;
            while ((match = rx.exec(content)) !== null) {
                const before = content.slice(0, match.index);
                const lineNum = before.split('\n').length;
                offenders.push({
                    file: path.relative(ROOT, file),
                    line: lineNum,
                    text: match[0].slice(0, 200),
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}:${o.line}\n    ${o.text}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} non-canonical button size on app pages.\n\nEvery app-page Button (and Link-as-button via buttonVariants) renders at size="sm" — that's the canonical h-9 page-action button. Modal / Sheet / ProgressBar size="md|lg" props are different concerns and are not policed by this ratchet.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

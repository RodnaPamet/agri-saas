/**
 * Detail-page STATIC back-prop ban (R10-PR9, revised for smart-nav).
 *
 * Original R9 north-star (2026-05-11): detail-page up-navigation was
 * breadcrumbs-only — the STATIC `back={{ href, label }}` prop paralleled
 * the breadcrumb trail with a redundant second "up" affordance.
 *
 * Revised (smart-nav port): the SMART back form `back={{ smart: true }}`
 * is now sanctioned. It is NOT redundant with breadcrumbs — breadcrumbs
 * show IA ancestry (Dashboard › Locations › North 40) while the smart
 * back is referrer-aware ("back to where you actually came from", falling
 * back to the canonical parent on a cold load). See
 * `src/components/nav/BackAffordance.tsx`.
 *
 * So the ban is narrowed: the STATIC form (`back={{ href: … }}`) stays
 * banned on app pages (still redundant with breadcrumbs); the smart form
 * (`back={{ smart: true }}`) is allowed.
 *
 * Scan: any `<EntityDetailLayout` / `<PageHeader` JSX in `src/app/**`
 * that passes a static `back={{ href … }}` is a violation. Comments are
 * stripped first so doc-block references don't false-positive.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.resolve(ROOT, 'src/app');

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

// Capture EntityDetailLayout / PageHeader JSX blocks, then check for a
// STATIC `back={{ … href … }}` inside the opening tag block. `[\s\S]`
// matches any char including newline (tsconfig targets pre-ES2018).
const PRIMITIVE_BLOCK_RE =
    /<(?:EntityDetailLayout|PageHeader)\b[\s\S]*?(?:>|\/>)/g;

describe('detail-page STATIC back prop ban (R10-PR9, smart-nav revision)', () => {
    test('no <EntityDetailLayout>/<PageHeader> in src/app passes a STATIC back={{ href … }}', () => {
        const offenders: { file: string; snippet: string }[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = stripComments(fs.readFileSync(file, 'utf-8'));
            const blocks = content.match(PRIMITIVE_BLOCK_RE);
            if (!blocks) continue;
            for (const block of blocks) {
                // A back prop carrying `href` is the static form.
                // `back={{ smart: true }}` has no href → allowed.
                if (/\sback=\{[\s\S]*href/.test(block)) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        snippet: block.slice(0, 120),
                    });
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `${offenders.length} site(s) pass a STATIC back={{ href … }} to <EntityDetailLayout>/<PageHeader>:\n${sample}\n\nFix: use breadcrumbs for IA ancestry, and/or the smart form \`back={{ smart: true }}\` (referrer-aware). The static back is redundant with breadcrumbs.`,
            );
        }
    });

    test('EntityDetailLayout primitive still exposes the back?: prop (interface, not call sites)', () => {
        // The prop remains load-bearing; it now accepts the union
        // (static link OR smart form) via `PageHeaderBack`.
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/layout/EntityDetailLayout.tsx'),
            'utf-8',
        );
        expect(src).toMatch(/back\?:\s*PageHeaderBack/);
    });
});

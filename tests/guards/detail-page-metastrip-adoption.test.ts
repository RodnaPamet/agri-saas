/**
 * Elevation PR-1 — MetaStrip adoption ratchet.
 *
 * Asserts that every detail page passing a `meta` prop to
 * `<EntityDetailLayout>` uses `<MetaStrip>` rather than a raw
 * `<>` fragment of `<StatusBadge>` instances.
 *
 * Why this ratchet
 *   The MetaStrip primitive shipped in the Polish PR-5 package but
 *   no detail page consumed it. Until adoption lands, the visible
 *   product is unchanged: each page still hand-assembles a fragment
 *   of badges. The whole point of the primitive — that crossing
 *   detail pages reads as one composition — sits unrealised.
 *
 * Detection
 *   Files matching `src/app/.../[idParam]/page.tsx` (or sibling
 *   Client.tsx) that import `EntityDetailLayout` and pass a `meta`
 *   prop. The `meta` prop value MUST reference `<MetaStrip` —
 *   either the JSX element directly or a variable assigned to it
 *   (e.g. `headerMeta = (<MetaStrip ... />)`).
 *
 * What this ratchet does NOT police
 *   Detail pages that pass `meta={undefined}` or no `meta` prop at
 *   all (no migration needed). Pages outside the `[idParam]` glob
 *   (admin sub-pages, settings) — those have separate conventions.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EXEMPT_FILE_PATTERNS: RegExp[] = [
    /\.test\.tsx?$/,
    /\.spec\.tsx?$/,
    /\.stories\.tsx?$/,
];

const EDL_IMPORT_RE =
    /from\s+['"]@\/components\/layout\/EntityDetailLayout['"]/;
const META_PROP_RE = /\bmeta=\{/;
const METASTRIP_USE_RE = /<MetaStrip\b/;

interface Hit {
    file: string;
    reason: string;
}

function findDetailPages(): string[] {
    const out: string[] = [];
    function walk(dir: string) {
        if (!fs.existsSync(dir)) {
            throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rel = path.relative(ROOT, full);
            if (entry.name === 'node_modules') continue;
            if (entry.name.startsWith('__')) continue;
            if (EXEMPT_FILE_PATTERNS.some((rx) => rx.test(rel))) continue;
            if (entry.isDirectory()) walk(full);
            else if (
                /\.(tsx|jsx)$/.test(entry.name) &&
                /\[[^/]+\][/].*page\.tsx?$|\[[^/]+\][/].*Client\.tsx?$/.test(rel)
            ) {
                out.push(rel);
            }
        }
    }
    walk(path.join(ROOT, 'src/app'));
    return out;
}

describe('Detail-page MetaStrip adoption (Elevation PR-1)', () => {
    it('every detail page passing a `meta` prop to EntityDetailLayout uses <MetaStrip>', () => {
        const offenders: Hit[] = [];
        for (const rel of findDetailPages()) {
            const abs = path.resolve(ROOT, rel);
            const content = fs.readFileSync(abs, 'utf8');
            if (!EDL_IMPORT_RE.test(content)) continue;
            if (!META_PROP_RE.test(content)) continue;
            // Page passes a `meta` prop. It must reference MetaStrip
            // somewhere in the file (the meta value can be inline JSX
            // or a variable assigned to <MetaStrip ... />).
            if (METASTRIP_USE_RE.test(content)) continue;
            offenders.push({
                file: rel,
                reason:
                    'passes `meta={...}` to EntityDetailLayout but does not use <MetaStrip>',
            });
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file} — ${o.reason}`)
                .join('\n');
            throw new Error(
                `Found ${offenders.length} detail page(s) passing a meta prop without using MetaStrip.\n\nThe MetaStrip primitive (src/components/ui/meta-strip.tsx) is the canonical "entity facts at a glance" surface. Replace the inline <>...<StatusBadge>...</> fragment with <MetaStrip items={[...]} /> so detail pages share one composition.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });

    it('the detail-page scanner finds at least the canonical detail surfaces', () => {
        const found = findDetailPages();
        expect(found.length).toBeGreaterThan(3);
    });
});

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

    // ── Control: `walk` must actually select a population (#971) ─────────
    //
    // `walk` is the ONLY producer of the file list this ban scans, consumed at
    // `for (const file of walk(APP_ROOT))` below. Gut it to an empty ITERABLE
    // ([], '', new Set(), new Map()) and the loop runs zero times: `offenders`
    // stays empty, the guard passes, and nothing was looked at. (The
    // non-iterable guts — 0, null, undefined, false, {} — throw at the for-of
    // and are already caught; only the empty-iterable ones survive.)
    //
    // The `fs.existsSync` throw above covers a renamed ROOT and nothing else —
    // not the recursion, not the `.tsx` filter, not the count.
    //
    // Floors are MEASURED on main (2026-09-19) and set far below reality so no
    // feature PR has to move them.
    test('walk() selects a real, recursive .tsx population under src/app', () => {
        const scanned = walk(APP_ROOT);

        // Measured: 214 .tsx files under src/app.
        expect(scanned.length).toBeGreaterThan(100);

        // Shape: absolute, inside the scan root, .tsx only, no duplicates.
        for (const file of scanned) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(file.startsWith(APP_ROOT + path.sep)).toBe(true);
            expect(file.endsWith('.tsx')).toBe(true);
        }
        expect(new Set(scanned).size).toBe(scanned.length);

        // RECURSION — the one behaviour no gut VALUE can express. A walk that
        // stopped recursing would return just the 7 files sitting directly in
        // src/app and still look like a healthy non-empty list. Measured: 191
        // files sit 4+ path segments below APP_ROOT.
        const nested = scanned.filter(
            (file) => path.relative(APP_ROOT, file).split(path.sep).length >= 4,
        );
        expect(nested.length).toBeGreaterThan(50);
    });

    // ── Positive control: the population reaches the JSX this guard bans ──
    //
    // A file COUNT alone is satisfied by a walk returning 214 files the
    // detector can never see. This exercises the whole
    // walk -> stripComments -> PRIMITIVE_BLOCK_RE pipeline against REAL
    // product source. Measured on main: 13 files under src/app mount
    // <EntityDetailLayout>/<PageHeader>, yielding 28 opening-tag blocks.
    test('the scanned population contains real <EntityDetailLayout>/<PageHeader> JSX', () => {
        let filesWithBlocks = 0;
        let blocks = 0;

        for (const file of walk(APP_ROOT)) {
            const matched = stripComments(
                fs.readFileSync(file, 'utf-8'),
            ).match(PRIMITIVE_BLOCK_RE);
            if (!matched) continue;
            filesWithBlocks += 1;
            blocks += matched.length;
        }

        expect(filesWithBlocks).toBeGreaterThan(5);
        expect(blocks).toBeGreaterThan(10);
    });

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

    // ── Control: `stripComments` must strip COMMENTS, not the corpus (#971) ─
    //
    // Consumed as `stripComments(readFileSync(...)).match(PRIMITIVE_BLOCK_RE)`.
    // Every gut but one throws `.match is not a function` and is already
    // caught (0, null, undefined, false, {}, [], Set, Map — none of those have
    // `.match`). The survivor is `''`: `''.match(...)` returns null, all 214
    // files hit the `continue`, and the guard passes having read every file
    // and looked at none.
    //
    // The gut set only reaches "strip everything". The direction it CANNOT
    // reach is the one a real refactor produces — a regex that eats live code
    // (make the block-comment pattern greedy and everything between the first
    // `/*` and the last `*/` vanishes, JSX included). So both halves are
    // asserted: comments go, code stays.
    test('stripComments removes comments and preserves the code the ban reads', () => {
        const banned = "back={{ href: '/t/acme/locations', label: 'Locations' }}";
        const blockCommented = `/**\n * ${banned}\n */\nconst keep = 1;`;
        const lineCommented = `// ${banned}\nconst keep = 1;`;

        // Planted positives: the banned shape written as a comment must NOT
        // survive — that is the entire reason this helper exists.
        expect(stripComments(blockCommented)).not.toContain('href');
        expect(stripComments(lineCommented)).not.toContain('href');

        // Clean negatives: the surrounding code survives both strips.
        expect(stripComments(blockCommented)).toContain('const keep = 1;');
        expect(stripComments(lineCommented)).toContain('const keep = 1;');

        // Near-miss: the same shape as LIVE JSX must survive, or the detector
        // can never see a violation in the first place.
        const live = `        <EntityDetailLayout\n            ${banned}\n        >`;
        expect(stripComments(live)).toContain('href');
    });

    test('stripComments leaves the real src/app corpus readable', () => {
        // Against real product source, not fixtures: a fixture cannot show
        // that the stripper leaves the PRODUCT intact enough to scan.
        let originalBytes = 0;
        let strippedBytes = 0;
        let shrank = 0;
        let backPropSites = 0;

        for (const file of walk(APP_ROOT)) {
            const source = fs.readFileSync(file, 'utf-8');
            const stripped = stripComments(source);
            originalBytes += source.length;
            strippedBytes += stripped.length;
            if (stripped.length < source.length) shrank += 1;
            // Derived from the product, never hardcoded to a path: whatever
            // call sites pass a `back` prop today must still carry it AFTER
            // stripping. Measured on main: 1 (the sanctioned
            // `back={{ smart: true }}` on the location detail page). If this
            // ever reaches 0, re-derive it — a ban whose subject has no live
            // call site is news, not noise.
            if (/\sback=\{/.test(stripped)) backPropSites += 1;
        }

        // It really strips: measured, 211 of 214 files shrink.
        expect(shrank).toBeGreaterThan(100);
        // It does not strip the corpus away: measured ratio 0.831.
        expect(strippedBytes).toBeGreaterThan(originalBytes * 0.5);
        // And the exact shape this guard reads survives the stripper.
        expect(backPropSites).toBeGreaterThan(0);
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

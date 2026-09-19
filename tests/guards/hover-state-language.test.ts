/**
 * Roadmap-3 PR-3 — hover-state language discipline.
 *
 * Repo audit found EIGHT competing hover treatments coexisting:
 *
 *   hover:bg-bg-muted       (56 sites — strong saturation)
 *   hover:bg-bg-muted/50    ( 5 sites — soft surface hover)
 *   hover:bg-bg-muted/40    ( 3 sites — soft input hover)
 *   hover:bg-bg-elevated/30 (12 sites — alternate "soft")
 *   hover:bg-bg-default/30  ( 6 sites — alternate "soft")
 *   hover:bg-transparent    (12 sites — ghost-button reset)
 *   hover:bg-neutral-50     ( 3 sites — off-token, raw palette)
 *   status-coloured hovers  (small counts — intentional, scoped)
 *
 * The product had three different "soft hover" approaches doing
 * the same job. The user feels the cursor moving across surfaces
 * with subtly different warmth and reads it as drift. This PR
 * consolidates the soft-hover language and bans the off-token
 * outlier.
 *
 * What this PR enforces (the canonical vocabulary)
 *
 *   • `hover:bg-bg-muted`         — full saturation. Used by
 *     buttons / inputs where the surface IS the affordance.
 *   • `hover:bg-bg-muted/50`      — soft surface hover. Used by
 *     rows / cards / nav items where the hover is a hint, not
 *     the primary affordance. THE canonical "soft" hover.
 *   • `hover:bg-bg-muted/40`      — soft input hover. Used by
 *     input-shaped affordances (search anchor, combobox
 *     trigger). Slightly lighter than the surface hover so
 *     input shapes feel a touch quieter.
 *   • `hover:bg-bg-{success,error,warning,info}` — status-
 *     context hover for color-coded interactive surfaces.
 *     Intentional, scoped, untouched.
 *   • `hover:bg-transparent`      — ghost-button reset only.
 *
 * What this PR bans
 *
 *   • `hover:bg-neutral-50` (and any `hover:bg-neutral-*`) —
 *     raw Tailwind palette, doesn't theme.
 *   • `hover:bg-bg-elevated/30` and `hover:bg-bg-default/30` —
 *     redundant with the soft surface hover. Pages that used
 *     these migrate to `hover:bg-bg-muted/50`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const BANNED_PATTERNS: Array<{ rx: RegExp; canonical: string }> = [
    {
        rx: /hover:bg-neutral-/,
        canonical: 'hover:bg-bg-muted/50 (or whichever fits — but never raw palette)',
    },
    {
        rx: /hover:bg-bg-elevated\/30\b/,
        canonical: 'hover:bg-bg-muted/50',
    },
    {
        rx: /hover:bg-bg-default\/30\b/,
        canonical: 'hover:bg-bg-muted/50',
    },
];

interface Hit {
    file: string;
    line: number;
    text: string;
    canonical: string;
}

function walk(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
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

describe('Hover-state language (Roadmap-3 PR-3)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test failed. Its only
    // call site is the `for (const file of walk(...))` loop below, so an
    // empty return makes that loop run zero times: `offenders` stays
    // empty, the throw never fires, and `expect(offenders).toHaveLength(0)`
    // passes. "826 files scanned, every hover is on-canon" and "no file
    // was ever opened" were the same green.
    //
    // Exactly ONE gut is ever scored here: the declared `: string[]`
    // return type is what stops `'' / 0 / null / undefined / false /
    // new Set() / new Map() / {}` from compiling, so the tool skips them
    // rather than scoring them. That annotation — not any assertion —
    // was this guard's entire defence, and `''` / `Set` / `Map` would
    // all have sailed through the `for…of` seam had it been loosened.
    //
    // The `fs.existsSync` throw INSIDE `walk` (#875) does not cover it
    // either: gutting replaces the WHOLE function, so that floor never
    // runs. A check one layer down cannot protect a caller that stops
    // calling it — which is why it is asserted below at the call site.

    it('control: walk returns the real population under both scan roots, and excludes what it claims to', () => {
        const files = ['src/app', 'src/components'].flatMap((root) =>
            walk(path.join(ROOT, root)),
        );

        // Measured 2026-09-19: 826 files (214 under src/app + 613 under
        // src/components, less the one `.tsx` inside an excluded
        // `__tests__` directory). The floor sits far below that, so
        // ordinary feature PRs never move it — and it is what would kill
        // `''` / `new Set()` / `new Map()` if the return annotation were
        // ever loosened, since none of them has a `.length` over 400.
        expect(files.length).toBeGreaterThan(400);
        expect(files.every((f) => /\.(tsx|jsx)$/.test(f))).toBe(true);

        const rels = files.map((f) =>
            path.relative(ROOT, f).split(path.sep).join('/'),
        );
        expect(rels.filter((r) => r.startsWith('..'))).toEqual([]);
        // BOTH roots must contribute. Half a scan reported as a whole
        // one is the same defect one size down.
        expect(rels.some((r) => r.startsWith('src/app/'))).toBe(true);
        expect(rels.some((r) => r.startsWith('src/components/'))).toBe(true);

        // RECURSION — the one behaviour a constant return cannot
        // express. Measured: the deepest page sits 9 segments below the
        // repo root (`src/app/t/[tenantSlug]/(app)/grain/bins/[binId]/…`),
        // and a top-level-only walk returns 16 files, not 826.
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(5);

        // The exclusions must BITE, and the SECOND enumeration is the
        // point: `readdirSync({ recursive: true })` walks the same two
        // roots without walk's filters, so the pair of numbers says what
        // walk dropped instead of asserting that it dropped something.
        const excludedDirs = ['node_modules', '__tests__'];
        const everyTsx = ['src/app', 'src/components'].flatMap((root) =>
            fs
                .readdirSync(path.join(ROOT, root), { recursive: true })
                .map((e) => `${root}/${String(e).split(path.sep).join('/')}`)
                .filter((r) => /\.(tsx|jsx)$/.test(r)),
        );
        const excluded = everyTsx.filter((r) =>
            r.split('/').some((seg) => excludedDirs.includes(seg)),
        );
        // Measured: exactly one — the co-located hooks test under
        // `src/components/ui/hooks/__tests__`. At zero the exclusion has
        // stopped being exercised, and this says so rather than passing
        // over an empty set.
        expect(excluded.length).toBeGreaterThan(0);
        expect(rels.filter((r) => excluded.includes(r))).toEqual([]);
        // Both directions of the difference, reported as PATHS rather
        // than as an 826-entry set diff nobody can read.
        const expected = new Set(
            everyTsx.filter((r) => !excluded.includes(r)),
        );
        const got = new Set(rels);
        expect(rels.filter((r) => !expected.has(r))).toEqual([]);
        expect([...expected].filter((r) => !got.has(r))).toEqual([]);
    });

    it('control: walk refuses a missing scan root instead of reporting zero files (#875)', () => {
        // This floor lives INSIDE walk, so the gut that empties the
        // function deletes the floor with it. Asserted out here, on the
        // call the tests actually make, it survives that mutation.
        expect(() =>
            walk(path.join(ROOT, 'src/app-renamed-by-a-refactor')),
        ).toThrow(/scan root does not exist/);
        // …and the two roots this guard names are the ones that exist,
        // so the throw above is live defence rather than documentation.
        for (const root of ['src/app', 'src/components']) {
            expect(fs.existsSync(path.join(ROOT, root))).toBe(true);
        }
    });
    it('control: BANNED_PATTERNS catches a planted off-canon hover and leaves the canonical vocabulary alone', () => {
        const hits = (line: string) =>
            BANNED_PATTERNS.filter(({ rx }) => rx.test(line)).length;

        // POSITIVE CONTROL, derived from REAL product source. Nothing in
        // `src/` matches a banned pattern today — that is this guard
        // being green — so the positive is MANUFACTURED by rewriting one
        // token of a real canonical line. It cannot go stale: a product
        // that stopped using `hover:bg-bg-muted/50` reddens the
        // derivation instead of quietly leaving nothing to mutate.
        const canonicalLines = ['src/app', 'src/components']
            .flatMap((root) => walk(path.join(ROOT, root)))
            .flatMap((file) => fs.readFileSync(file, 'utf-8').split('\n'))
            .filter((line) => line.includes('hover:bg-bg-muted/50'));
        // Measured 2026-09-19: 22 lines (4 under src/app, 18 under
        // src/components).
        expect(canonicalLines.length).toBeGreaterThan(5);

        // The NEAR-MISS direction first: `/50` is one character from
        // `/30`, and all 22 real lines must stay clean. A pattern
        // widened to `hover:bg-bg-` would light up every one of them.
        expect(canonicalLines.filter((line) => hits(line) > 0)).toEqual([]);

        // The same real line, one token changed. Each banned spelling is
        // caught, and caught EXACTLY once — so a pattern list that
        // collapsed onto its cheapest member is caught too.
        for (const banned of [
            'hover:bg-bg-elevated/30',
            'hover:bg-bg-default/30',
            'hover:bg-neutral-50',
        ]) {
            expect(
                hits(canonicalLines[0].replace('hover:bg-bg-muted/50', banned)),
            ).toBe(1);
        }

        // The rest of the vocabulary the docblock declares canonical
        // stays legal, plus one near miss the ban deliberately does not
        // reach (`bg-neutral-50` with no `hover:` prefix is the raw-
        // palette guard's business, not this one's).
        for (const legal of [
            'hover:bg-bg-muted',
            'hover:bg-bg-muted/50',
            'hover:bg-transparent',
            'hover:bg-bg-success',
            'bg-neutral-50',
        ]) {
            expect(hits(`<div className="rounded ${legal} p-2" />`)).toBe(0);
        }

        // And every pattern carries the fix it wants — the `canonical`
        // string is the only thing a contributor sees in the failure.
        expect(BANNED_PATTERNS.length).toBeGreaterThanOrEqual(3);
        for (const { canonical } of BANNED_PATTERNS) {
            expect(canonical).toMatch(/hover:bg-/);
        }
    });

    it('zero off-canon hover backgrounds in src/app + src/components', () => {
        const offenders: Hit[] = [];
        for (const root of ['src/app', 'src/components']) {
            for (const file of walk(path.join(ROOT, root))) {
                const content = fs.readFileSync(file, 'utf-8');
                const lines = content.split('\n');
                lines.forEach((line, i) => {
                    const trimmed = line.trim();
                    if (
                        trimmed.startsWith('//') ||
                        trimmed.startsWith('*') ||
                        trimmed.startsWith('/*')
                    )
                        return;
                    for (const { rx, canonical } of BANNED_PATTERNS) {
                        if (rx.test(line)) {
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: i + 1,
                                text: trimmed.slice(0, 200),
                                canonical,
                            });
                            break;
                        }
                    }
                });
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line}\n    → use: ${o.canonical}\n    ${o.text}`,
                )
                .join('\n');
            throw new Error(
                `Found ${offenders.length} off-canon hover background(s).\n\nThe product carries TWO soft-hover variants and one full-saturation:\n  • hover:bg-bg-muted/50  — soft surface (rows / cards / nav items)\n  • hover:bg-bg-muted/40  — soft input (search anchor / combobox)\n  • hover:bg-bg-muted     — full saturation (buttons / inputs where the surface IS the affordance)\nplus status-coloured hovers (success/error/warning/info) for color-coded surfaces, and \`hover:bg-transparent\` for ghost-button resets.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

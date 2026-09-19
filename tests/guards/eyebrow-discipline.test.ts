/**
 * Roadmap-4 PR-3 — `<Eyebrow>` weight uniformity.
 *
 * The Eyebrow primitive renders with an intrinsic style:
 *
 *   block mb-1 text-xs font-semibold uppercase tracking-wider
 *   text-content-muted
 *
 * Five aspects are now LOCKED — no consumer should override them:
 *   • display       — block
 *   • bottom-margin — mb-1 (default; override only with another
 *                     spacing token, not raw values)
 *   • size          — text-xs
 *   • weight        — font-semibold
 *   • case          — uppercase
 *   • tracking      — tracking-wider
 *   • color         — text-content-muted (the canonical
 *                     secondary tone, per Roadmap-4 PR-1)
 *
 * What this ratchet bans on `<Eyebrow>` callsites
 *
 *   • text-{xs|sm|base|lg|xl|...} — size override.
 *   • font-{thin|light|normal|medium|semibold|bold|black} —
 *     weight override (a bare `font-semibold` would be redundant
 *     but harmless; a different weight is the real offence).
 *   • text-content-{emphasis|default|subtle} —
 *     tone override.
 *   • text-{gray|slate|neutral|zinc|stone}-N — raw palette grey
 *     (already banned by Roadmap-4 PR-1; this rule is the
 *     Eyebrow-specific reinforcement).
 *
 * What this ratchet does NOT police
 *
 *   • Layout overrides — `mb-N`, `mt-N`, `px-N`, `py-N`, `pt-N`,
 *     `pb-N`, `ml-N`, `mr-N`. The Eyebrow may sit in different
 *     spatial contexts (sidebar nav, card header, form field).
 *     The ratchet locks the typographic identity, not the
 *     position. Layout overrides remain legitimate.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

const EYEBROW_OPEN_RE = /<Eyebrow\b[^>]*?className\s*=\s*["']([^"']+)["']/g;

const BANNED_PATTERNS: Array<{ rx: RegExp; label: string }> = [
    { rx: /\btext-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)\b/, label: 'size override' },
    {
        rx: /\bfont-(?:thin|extralight|light|normal|medium|bold|extrabold|black)\b/,
        label: 'weight override',
    },
    {
        rx: /\btext-content-(?:emphasis|default|subtle)\b/,
        label: 'tone override',
    },
    {
        rx: /\btext-(?:gray|slate|neutral|zinc|stone)-\d+\b/,
        label: 'raw palette grey',
    },
];

interface Hit {
    file: string;
    line: number;
    text: string;
    label: string;
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

describe('Eyebrow uniformity (Roadmap-4 PR-3)', () => {
    // ── Controls (#971) ──────────────────────────────────────────────
    //
    // `selector-teeth` gutted `walk` and NOT ONE test failed. It is consumed
    // as `for (const file of walk(...))`, so every EMPTY-ITERABLE gut — []
    // '' new Set() new Map() — iterates zero times: `offenders` stays empty,
    // the throw never fires, and `toHaveLength(0)` passes over a scan that
    // opened no files. (The non-iterable guts 0 / null / undefined / false /
    // {} throw at the for-of and were already killed. `isolatedModules` in
    // tsconfig makes ts-jest transpile without type-checking, so the
    // `: string[]` annotation filters none of them.)
    //
    // The other test reads `typography.tsx` by a fixed path and never touches
    // `walk`, which is why the suite still reported a passing test.

    it('control: walk returns the real .tsx population, recurses, and its exclusions bite', () => {
        const files = ['src/app', 'src/components'].flatMap((root) =>
            walk(path.join(ROOT, root)),
        );
        // `Array.isArray` kills '' / new Set() / new Map(); the floor kills [].
        // Measured 2026-09-19: 826 files (src/app 214 + src/components 612),
        // so the floor sits at about half of reality and ordinary feature PRs
        // never move it.
        expect(Array.isArray(files)).toBe(true);
        expect(files.length).toBeGreaterThan(400);

        const rels = files.map((f) =>
            path.relative(ROOT, f).split(path.sep).join('/'),
        );
        // Exclusion 1 — the extension filter.
        expect(rels.filter((r) => !/\.(tsx|jsx)$/.test(r))).toEqual([]);

        // Exclusion 2 — `__tests__`, and it must actually BITE. Derived from
        // disk rather than asserted by name: measured 2026-09-19 that
        // directory holds one `.tsx`, which the population must not contain.
        const excludedDir = path.join(ROOT, 'src/components/ui/hooks/__tests__');
        expect(fs.existsSync(excludedDir)).toBe(true);
        expect(
            fs.readdirSync(excludedDir).filter((n) => n.endsWith('.tsx')).length,
        ).toBeGreaterThan(0);
        expect(rels.filter((r) => r.split('/').includes('__tests__'))).toEqual([]);

        // RECURSION — the one behaviour a constant return cannot express.
        // Measured: the deepest file sits 9 segments down
        // (src/app/t/[tenantSlug]/(app)/admin/integrations/sharepoint-health/page.tsx).
        expect(
            Math.max(...rels.map((r) => r.split('/').length)),
        ).toBeGreaterThanOrEqual(5);

        // And the population must contain the thing this ratchet is ABOUT.
        // Measured 2026-09-19: 9 scanned files mention `<Eyebrow`. "Zero
        // offenders" over a tree with no Eyebrow in it is a pass earned by
        // looking somewhere else.
        const mounting = rels.filter((r) =>
            /<Eyebrow\b/.test(fs.readFileSync(path.join(ROOT, r), 'utf-8')),
        );
        expect(mounting.length).toBeGreaterThan(4);
    });

    it('control: walk throws on a missing scan root (#875)', () => {
        // That throw lives INSIDE `walk`, so gutting the function deletes it
        // along with the traversal — a floor one layer down cannot protect a
        // caller that stops calling it. Assert it from the call site instead.
        expect(() =>
            walk(path.join(ROOT, 'src/components/__no_such_scan_root__')),
        ).toThrow(/scan root does not exist/);
        // …and the roots the offender scan passes it are real today, which is
        // the condition under which that throw means anything at all.
        for (const root of ['src/app', 'src/components']) {
            expect(fs.existsSync(path.join(ROOT, root))).toBe(true);
        }
    });
    it('Eyebrow primitive locks intrinsic styling', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/typography.tsx'),
            'utf-8',
        );
        // The intrinsic style must contain block + mb-1 + text-xs +
        // font-semibold + uppercase + tracking-wider + text-content-muted.
        for (const cls of [
            'block',
            'mb-1',
            'text-xs',
            'font-semibold',
            'uppercase',
            'tracking-wider',
            'text-content-muted',
        ]) {
            expect(src).toMatch(new RegExp(`['"\\s]${cls}\\b`));
        }
    });

    it('control: the banned-pattern detector catches a planted override and ignores near-misses', () => {
        // The offender scan below is written INLINE inside its `it()`, so
        // `selector-teeth` has no function to gut there — and nothing else
        // exercises EYEBROW_OPEN_RE or BANNED_PATTERNS either. Measured
        // 2026-09-19: ZERO `<Eyebrow …className=…>` callsites exist in the 826
        // scanned files, so `expect(offenders).toHaveLength(0)` is earned by
        // absence, not by detection — an empty BANNED_PATTERNS, a deleted
        // pattern, or a regex that matches nothing is green forever. This runs
        // the same two constants over planted input.
        const detect = (content: string): string[] => {
            const rx = new RegExp(EYEBROW_OPEN_RE.source, 'g');
            const labels: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = rx.exec(content)) !== null) {
                for (const { rx: bx, label } of BANNED_PATTERNS) {
                    if (bx.test(m[1])) {
                        labels.push(label);
                        break;
                    }
                }
            }
            return labels;
        };

        // POSITIVE CONTROL FROM REAL PRODUCT SOURCE. The banned shape has no
        // live instance, so it is manufactured by injecting a className into a
        // real `<Eyebrow>` mount — `card-header.tsx` — which is also proved to
        // be inside the scanned population. If the primitive stops being
        // mounted there this fails, instead of quietly testing a string.
        const consumer = path.join(ROOT, 'src/components/ui/card-header.tsx');
        expect(walk(path.join(ROOT, 'src/components'))).toContain(consumer);
        const raw = fs.readFileSync(consumer, 'utf-8');
        const tag = '<Eyebrow data-testid="card-header-eyebrow">';
        expect(raw.split(tag).length - 1).toBe(1);
        expect(detect(raw)).toEqual([]);
        expect(
            detect(
                raw.replace(
                    tag,
                    '<Eyebrow data-testid="card-header-eyebrow" className="text-lg">',
                ),
            ),
        ).toEqual(['size override']);

        // EVERY banned pattern fires, keyed by label and cross-checked against
        // BANNED_PATTERNS — so deleting a pattern (or adding one with no probe)
        // fails here rather than silently narrowing the ratchet.
        const probes: Record<string, string> = {
            'size override': 'text-lg',
            'weight override': 'font-bold',
            'tone override': 'text-content-emphasis',
            'raw palette grey': 'text-gray-400',
        };
        expect(Object.keys(probes).sort()).toEqual(
            BANNED_PATTERNS.map((p) => p.label).sort(),
        );
        for (const [label, cls] of Object.entries(probes)) {
            expect(detect(`<Eyebrow className="${cls}">x</Eyebrow>`)).toEqual([label]);
        }

        // Multi-line start tags are the real JSX shape here — every live
        // callsite wraps — so `[^>]*?` has to cross the newlines.
        expect(
            detect('<Eyebrow\n    data-testid="x"\n    className="text-xs"\n>x</Eyebrow>'),
        ).toEqual(['size override']);

        // NEAR-MISSES the docblock calls legitimate: a redundant `font-semibold`,
        // and the layout overrides this ratchet deliberately does NOT police.
        // A detector that flags these is noise; one that flags nothing is the bug.
        expect(detect('<Eyebrow className="font-semibold uppercase">x</Eyebrow>')).toEqual([]);
        expect(detect('<Eyebrow className="mb-4 mt-2 px-3">x</Eyebrow>')).toEqual([]);
        expect(detect('<div className="text-lg font-bold text-gray-400" />')).toEqual([]);
        expect(detect('<EyebrowGroup className="text-lg" />')).toEqual([]);
    });

    it('no Eyebrow callsite overrides typography (size / weight / tone / raw grey)', () => {
        const offenders: Hit[] = [];
        for (const root of ['src/app', 'src/components']) {
            for (const file of walk(path.join(ROOT, root))) {
                const content = fs.readFileSync(file, 'utf-8');
                const rx = new RegExp(EYEBROW_OPEN_RE.source, 'g');
                let m: RegExpExecArray | null;
                while ((m = rx.exec(content)) !== null) {
                    const className = m[1];
                    for (const { rx: bx, label } of BANNED_PATTERNS) {
                        if (bx.test(className)) {
                            const before = content.slice(0, m.index);
                            offenders.push({
                                file: path.relative(ROOT, file),
                                line: before.split('\n').length,
                                text: m[0].slice(0, 200),
                                label,
                            });
                            break;
                        }
                    }
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map(
                    (o) =>
                        `  ${o.file}:${o.line} [${o.label}]\n    ${o.text}`,
                )
                .join('\n');
            throw new Error(
                `Found ${offenders.length} Eyebrow callsite(s) overriding typography.\n\nThe Eyebrow primitive locks size, weight, case, tracking, and tone. Override layout (margin / padding) only — never typography.\n\nFirst ${Math.min(10, offenders.length)} offender(s):\n${sample}`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

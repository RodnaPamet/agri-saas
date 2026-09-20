/**
 * Roadmap-10 PR-10 — StatusBadge brand-orange forbidden.
 *
 * R9 north-star locked: status is not brand. The StatusBadge CVA
 * exposes five variants — `neutral | info | success | warning |
 * error` — each grounded in a content-token (text-content-info,
 * text-content-success, …). The brand-orange token
 * (var(--brand-default) / bg-bg-brand) is reserved for the product
 * surface (primary actions, brand chrome). Bleeding it into status
 * makes "this is the brand" and "this is a status signal" visually
 * indistinguishable.
 *
 * Two locks:
 *
 *   1. The CVA's `variant` union does NOT include `brand`. A
 *      contributor adding it has to delete this assertion first —
 *      and that delete is the conversation-starter.
 *
 *   2. No JSX call site passes `<StatusBadge variant="brand">`.
 *      Even if the variant existed, no app code reaches for it.
 *
 * The ratchet does NOT police inline orange Tailwind classes in
 * StatusBadge contexts — sibling ratchets (token-cheatsheet,
 * border-tone-budget) handle raw-color discipline.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (
                entry.name === 'node_modules' ||
                entry.name === '__tests__' ||
                entry.name === '__mocks__'
            ) continue;
            walk(full, results);
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
            if (
                entry.name.endsWith('.test.tsx') ||
                entry.name.endsWith('.test.ts') ||
                entry.name.endsWith('.spec.tsx') ||
                entry.name.endsWith('.spec.ts')
            ) return results;
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

describe('StatusBadge brand-orange ban (R10-PR10)', () => {
    test("StatusBadge CVA `variant` does NOT include `'brand'`", () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/status-badge.tsx'),
            'utf-8',
        );
        // Extract the `variant: { … }` block of the CVA. The block
        // ends at the first closing brace at the same indent level.
        const variantBlockMatch = src.match(
            /variant:\s*\{([^}]+)\}/,
        );
        expect(variantBlockMatch).not.toBeNull();
        const block = variantBlockMatch![1];
        // The block must NOT contain a literal `brand:` key.
        expect(block).not.toMatch(/\bbrand:/);
        // Sanity: the canonical five MUST be present.
        expect(block).toMatch(/neutral:/);
        expect(block).toMatch(/info:/);
        expect(block).toMatch(/success:/);
        expect(block).toMatch(/warning:/);
        expect(block).toMatch(/error:/);
    });

    /**
     * CONTROL for `stripComments` — it had NO TEETH (survived all nine guts).
     *
     * The scan below reads `stripComments(readFileSync(file))` and then tests
     * a regex against the result. Gut the masker to ANY constant and every
     * file's content becomes that constant, the regex matches nothing,
     * `offenders` stays empty, and the ban reports a clean tree having
     * examined no source at all (#971).
     *
     * Asserted two-sided, which is the only form that works for a masker:
     *   expect(stripped.length).toBeGreaterThan(0)      it did not eat everything
     *   expect(stripped.length).toBeLessThan(raw.length) it did strip something
     * Either assertion ALONE passes for a degenerate stripper — the first for
     * an identity function, the second for one returning ''.
     */
    /**
     * CONTROL for `walk` — it survived the four EMPTY ITERABLES.
     *
     * The scan consumes it as `for (const file of walk(root))`. That seam
     * throws on the five non-iterable guts (0 null undefined false {}) but
     * accepts [] '' new Set() new Map() and iterates nothing, so the ban
     * reported no brand-orange call sites having opened no files at all.
     * The 4-of-9 signature (#971).
     *
     * `walk`'s own #875 throw cannot catch this: it fires only when a scan
     * root is RENAMED. Two roots that both exist, walked by a collector that
     * returns an empty iterable, sail straight past it.
     *
     * Collected through the guard's OWN for-of seam rather than flatMap —
     * flatMap would WRAP a non-array return instead of rejecting it, making
     * the control weaker than the code it certifies.
     */
    test('control: walk returns the real, recursive .tsx population', () => {
        const scanRoots = ['src/app', 'src/components'];
        const files: string[] = [];
        for (const root of scanRoots) {
            for (const file of walk(path.resolve(ROOT, root))) {
                files.push(file);
            }
        }
        // 827 .tsx files under these two roots today; the floor sits far
        // below so ordinary churn never trips it, and only an EMPTY scan does.
        expect(files.length).toBeGreaterThan(300);

        for (const f of files) {
            expect(typeof f).toBe('string');
            expect(fs.statSync(f).isFile()).toBe(true);
        }

        // RECURSION — the one behaviour a constant return cannot express.
        // Components sit several directories below the root, so a walker that
        // read only the top level would miss almost the entire population.
        const deepest = Math.max(
            ...files.map((f) => path.relative(ROOT, f).split(path.sep).length),
        );
        expect(deepest).toBeGreaterThanOrEqual(4);

        // The #875 guarantee is part of the mechanism, not decoration.
        expect(() => walk(path.resolve(ROOT, 'src/app-renamed-away'))).toThrow(
            /scan root does not exist/,
        );
    });

    test('control: stripComments removes comments and keeps code', () => {
        const raw = [
            'const a = 1; // trailing line comment',
            '/* a block',
            '   comment spanning lines */',
            'const b = <StatusBadge variant="ok" />;',
        ].join('\n');
        const stripped = stripComments(raw);

        // Both halves, or the control is worthless.
        expect(stripped.length).toBeGreaterThan(0);
        expect(stripped.length).toBeLessThan(raw.length);

        // The code survives...
        expect(stripped).toContain('const a = 1;');
        expect(stripped).toContain('<StatusBadge variant="ok" />');
        // ...and the prose does not.
        expect(stripped).not.toContain('trailing line comment');
        expect(stripped).not.toContain('comment spanning lines');

        // Grounded in the tree as well: run it over real source and show it
        // returns substantive content rather than a constant.
        const realFile = path.resolve(ROOT, 'src/components/ui/status-badge.tsx');
        const realRaw = fs.readFileSync(realFile, 'utf-8');
        const realStripped = stripComments(realRaw);
        expect(realStripped.length).toBeGreaterThan(200);
        expect(realStripped).toContain('variant');
    });

    test('no JSX call site passes <StatusBadge variant="brand">', () => {
        const offenders: string[] = [];
        const scanRoots = ['src/app', 'src/components'];
        for (const root of scanRoots) {
            for (const file of walk(path.resolve(ROOT, root))) {
                const content = stripComments(fs.readFileSync(file, 'utf-8'));
                // Match <StatusBadge ...variant="brand"... in either order
                // and single/double quotes. `[^>]*?` keeps the match inside
                // the opening tag.
                if (
                    /<StatusBadge\b[^>]*\bvariant=["']brand["']/.test(content)
                ) {
                    offenders.push(path.relative(ROOT, file));
                }
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} site(s) pass variant="brand" to <StatusBadge>:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: pick the semantic variant that matches the status meaning — neutral / info / success / warning / error. Brand orange is reserved for product surface (primary actions, brand chrome), not status signals.',
            );
        }
    });
});

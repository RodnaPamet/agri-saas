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

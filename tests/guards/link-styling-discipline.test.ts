/**
 * Roadmap-4 PR-10 — link styling discipline.
 *
 * Inline links (the kind that read "click here to ..." inside a
 * paragraph or table cell) had drifted to a hand-rolled
 * `text-[var(--brand-default)] hover:underline` cocktail across 5
 * call sites:
 *
 *   • controls/[controlId]/page.tsx (×2) — evidence URL link,
 *     evidence card link
 *   • vendors/VendorsClient.tsx — vendor name link in row
 *
 * The TextLink primitive at `@/components/ui/typography` already
 * defined `default` / `muted` / `brand` / `underline` tones, but
 * none of them captured the inline-link affordance: brand colour
 * at rest, underlined on hover. Five sites invented the same
 * cocktail because there was no canonical surface for it.
 *
 * What lands
 *
 *   1. New `link` tone on `textLinkVariants`:
 *        text-[var(--brand-default)]
 *        hover:text-[var(--brand-emphasis)]
 *        hover:underline
 *
 *      Brand-coloured at rest; on hover, deepens to brand-
 *      emphasis AND underlines — the conventional "this is a
 *      clickable link" affordance.
 *
 *   2. Five drift sites migrated to apply `textLinkVariants({
 *      tone: 'link' })` as their className. They keep using
 *      `<Link>` (next/link routing) — the helper is just the
 *      class string.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may pair `text-[var(--brand-
 *   default)]` with `hover:underline` in the same `className`.
 *   Either drop one (the resulting tone matches an existing
 *   variant) or use `textLinkVariants({ tone: 'link' })` for the
 *   canonical inline-link affordance.
 *
 * What this ratchet does NOT police
 *
 *   - `hover:underline` on its own. That's a chrome affordance,
 *     not a link rendering. Many sidebar nav items use it
 *     legitimately.
 *
 *   - `text-[var(--brand-default)]` without `hover:underline`.
 *     That matches the existing `brand` tone and is a valid
 *     non-link surface (badges, eyebrow accents, …).
 *
 *   - `<TextLink>` itself. Direct callers using the primitive
 *     are by definition compliant.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// Match a className that contains BOTH `text-[var(--brand-default)]`
// (or the equivalent `hover:text-[var(--brand-default)]`) and
// `hover:underline`. Any order, anywhere in the class string.
const DRIFT_RE =
    /className\s*=\s*["'`][^"'`]*\btext-\[var\(--brand-default\)\][^"'`]*\bhover:underline\b[^"'`]*["'`]|className\s*=\s*["'`][^"'`]*\bhover:underline\b[^"'`]*\btext-\[var\(--brand-default\)\][^"'`]*["'`]/;

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Link styling discipline (Roadmap-4 PR-10)', () => {
    it('typography primitive exposes the `link` tone', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/typography.tsx'),
            'utf-8',
        );
        // Match the tone definition with the three pieces of the
        // canonical class string.
        expect(src).toMatch(/link:\s*\n?\s*"[^"]*text-\[var\(--brand-default\)\]/);
        expect(src).toMatch(/link:\s*\n?\s*"[^"]*hover:text-\[var\(--brand-emphasis\)\]/);
        expect(src).toMatch(/link:\s*\n?\s*"[^"]*hover:underline/);
    });

    it('no .tsx under src/ pairs text-[var(--brand-default)] with hover:underline', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const lines = fs.readFileSync(full, 'utf-8').split('\n');
                lines.forEach((line, i) => {
                    if (DRIFT_RE.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Hand-rolled inline-link styling. Use textLinkVariants({ tone: 'link' }) from @/components/ui/typography, or wrap the children in <TextLink tone="link">:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

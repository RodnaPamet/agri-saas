/**
 * Roadmap-11 PR-2 — Skeleton shimmer adoption.
 *
 * The `<Skeleton>` primitive in `src/components/ui/skeleton.tsx`
 * now renders a gradient-sweep shimmer (translateX `::after`
 * overlay) on top of the static colour bar. Every loading.tsx
 * file under `src/app/t/[tenantSlug]/(app)/**` should reach the
 * shared primitive — NOT hand-roll its own `animate-pulse` divs.
 * Without this rule, those files render the legacy static block
 * and the rollout looks half-finished.
 *
 * The ratchet locks two invariants:
 *
 *   1. `Skeleton` primitive carries the canonical
 *      `after:animate-shimmer-sweep` class plus the
 *      `motion-reduce` fallback. If a future "tidy-up" PR
 *      strips the gradient overlay, CI fails.
 *
 *   2. Every `loading.tsx` under `src/app/t/[tenantSlug]/(app)/**`
 *      imports from `@/components/ui/skeleton` (or is exempt via
 *      EXEMPTIONS with a written reason — e.g. a non-skeleton
 *      loading surface).
 *
 * EXEMPTIONS captures the long tail of loading.tsx files that
 * intentionally render something other than a skeleton (e.g. a
 * "Loading…" toast or a non-list animated splash).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.resolve(ROOT, 'src/app/t/[tenantSlug]/(app)');

/**
 * loading.tsx files that intentionally do NOT use the shared
 * `<Skeleton>` primitive. None today. Future contributors who add
 * one must include a written reason here.
 */
const EXEMPTIONS: Record<string, string> = {};

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) {
        throw new Error(`scan root does not exist: ${dir} — a renamed root would scan zero files and pass (#875)`);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, results);
        else if (entry.name === 'loading.tsx') results.push(full);
    }
    return results;
}

describe('Skeleton shimmer adoption (R11-PR2)', () => {
    test('the shared Skeleton primitive renders the shimmer-sweep overlay', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'src/components/ui/skeleton.tsx'),
            'utf-8',
        );
        // Canonical shimmer signature on the primitive.
        expect(src).toMatch(/after:animate-shimmer-sweep/);
        // The sweep band must be visible — `via-white/[0.06]` (6%)
        // read as static. Locked at a perceptible opacity (≥ 0.12)
        // so a future "tidy" can't quietly fade it back to
        // imperceptible.
        const viaMatch = src.match(/after:via-white\/\[(0\.\d+)\]/);
        expect(viaMatch).not.toBeNull();
        expect(Number(viaMatch![1])).toBeGreaterThanOrEqual(0.12);
        // Reduced-motion fallback: the sweep is STOPPED + the band
        // PARKED centred (a static gloss highlight), NOT hidden +
        // `animate-pulse`. The old `animate-pulse` fallback was
        // dead — tokens.css's global reduced-motion rule flattens
        // every `animation-duration` to 1ms, so the pulse never
        // ran and reduced-motion users got a fully static block.
        expect(src).toMatch(/motion-reduce:after:animate-none/);
        expect(src).toMatch(/motion-reduce:after:translate-x-0/);
        // And the dead fallback is gone.
        expect(src).not.toMatch(/motion-reduce:after:hidden/);
        expect(src).not.toMatch(/motion-reduce:animate-pulse/);
    });

    test('the tailwind config defines shimmer-sweep keyframes + animation', () => {
        const src = fs.readFileSync(
            path.resolve(ROOT, 'tailwind.config.js'),
            'utf-8',
        );
        // Both the keyframe AND the animation entry must exist.
        expect(src).toMatch(/'shimmer-sweep':\s*\{/);
        expect(src).toMatch(/'shimmer-sweep':\s*'shimmer-sweep\s+/);
    });

    test("every loading.tsx imports from @/components/ui/skeleton", () => {
        const offenders: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const rel = path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/');
            if (EXEMPTIONS[rel]) continue;
            const src = fs.readFileSync(file, 'utf-8');
            if (
                !/from\s+['"]@\/components\/ui\/skeleton['"]/.test(src)
            ) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} loading.tsx file(s) don't import the shared Skeleton primitive:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: replace the hand-rolled `animate-pulse` divs with `<Skeleton>` (or any of the `Skeleton*` primitives in `src/components/ui/skeleton.tsx`).\n' +
                    'OR add the file path to EXEMPTIONS with a reason if the loading surface intentionally isn\'t a skeleton.',
            );
        }
    });

    test('no loading.tsx file hand-rolls a raw `animate-pulse` block', () => {
        // Stricter check: even if a loading.tsx imports Skeleton, it
        // shouldn't ALSO have raw `animate-pulse` div(s). Lock the
        // canonical shape: all loading affordance goes through the
        // primitive.
        const offenders: string[] = [];
        for (const file of walk(APP_ROOT)) {
            const rel = path
                .relative(APP_ROOT, file)
                .split(path.sep)
                .join('/');
            if (EXEMPTIONS[rel]) continue;
            const src = fs.readFileSync(file, 'utf-8');
            // Strip comments so `// animate-pulse` mentions don't trip.
            const stripped = src
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/\/\/[^\n]*/g, '');
            if (/\banimate-pulse\b/.test(stripped)) {
                offenders.push(rel);
            }
        }
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} loading.tsx file(s) still hand-roll \`animate-pulse\`:\n  ` +
                    offenders.join('\n  ') +
                    '\n\nFix: route the static block through `<Skeleton>` so the shimmer-sweep applies uniformly.',
            );
        }
    });
});

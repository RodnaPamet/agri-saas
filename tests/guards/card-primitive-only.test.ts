/**
 * Roadmap-5 PR-1 — Card primitive eradication.
 *
 * Before this PR, 86 callsites bypassed the typed `<Card>` /
 * `cardVariants()` API and reached for the legacy `.glass-card`
 * CSS class directly. The primitive's `density` and `elevation`
 * axes (the contract every later refinement leans on) were
 * routinely sidestepped.
 *
 * What landed
 *
 *   • Every consumer of glass-card now goes through one of the
 *     primitive's two doors:
 *       - `<Card>` (typed JSX wrapper) — for fresh `<div>` cards.
 *       - `cardVariants({ density, elevation })` — composable
 *         class-string for non-div consumers (`<form>`, `<button>`,
 *         `<section>`, `<a>`, `<details>`, …) and for sites that
 *         compose with `cn(...)` already.
 *
 *   • The literal `glass-card` token survives in two places only:
 *       - `src/components/ui/card.tsx` — the cardVariants `raised`
 *         elevation maps to it; the primitive IS the surface that
 *         owns the legacy class.
 *       - `src/app/globals.css` — the underlying CSS recipe.
 *     JSDoc comments referencing the class as documentation are
 *     fine (they describe intent, not behaviour).
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` outside `card.tsx` may contain the
 *   literal `glass-card` token in non-comment JSX context. The
 *   detector strips JSDoc / line-comment regions before scanning,
 *   so `// uses glass-card under the hood` and `* glass-card`
 *   doc bullets stay legal.
 *
 *   New consumers MUST go through `<Card>` or `cardVariants({...})`
 *   — adding a `glass-card` literal regresses the round.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles } from '../helpers/collect-files';

const ROOT = path.resolve(__dirname, '../..');
const PRIMITIVE = 'src/components/ui/card.tsx';
const VARIANTS = 'src/components/ui/card-variants.ts';

/**
 * The scanned population, collected by the SANCTIONED helper — #2483 class A.
 *
 * This was an inline recursive `walk` inside the `it()` below, which is why
 * `selector-teeth` reported this file as having no module-level selector: there
 * was nothing at module scope to mutate. The assertion is
 * `expect(offenders).toEqual([])`, so an emptied walk reported no legacy
 * `glass-card` anywhere having read nothing.
 *
 * Migrated rather than merely hoisted. #2483's remedy is to extract the walk so
 * the auditor can gut it, but `collectSourceFiles` is strictly stronger: it
 * REFUSES an empty result, so the population cannot be empty at all rather than
 * being emptied and caught. #865's docblock states the trade explicitly — "the
 * guarantee moves from 'we mutated its collector and it noticed' to 'its
 * collector cannot return empty'" — and expects the harness to then report the
 * file as NOT AUDITED, which is correct here rather than a regression.
 *
 * Population parity verified before the change: the hand-rolled walk and this
 * call both collect 871 files, with zero difference in either direction.
 * `DEFAULT_SKIP_DIRS` already covers the `node_modules` / `.next` skips the
 * walk spelled by hand.
 */
const SCANNED = collectSourceFiles({
    roots: ['src'],
    extensions: ['.tsx'],
    exclude: (rel) => rel === PRIMITIVE,
    // 871 today. The helper throws below this, which is the whole point.
    floor: 600,
});

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Card-primitive eradication of glass-card (Roadmap-5 PR-1)', () => {
    it('the primitive still owns the legacy class internally', () => {
        // Roadmap-5 hotfix — `cardVariants` now lives in
        // `card-variants.ts` (a non-"use client" sibling) so
        // server components can call it without hitting a client-
        // reference boundary.
        const variantsSrc = fs.readFileSync(path.join(ROOT, VARIANTS), 'utf-8');
        // cardVariants's `raised` elevation must still emit
        // `glass-card` so existing CSS keeps painting.
        expect(variantsSrc).toMatch(/raised:\s*"glass-card"/);
        const src = fs.readFileSync(path.join(ROOT, PRIMITIVE), 'utf-8');
        // The primitive still re-exports cardVariants for callers
        // that grab `{ Card, cardVariants }` together.
        expect(src).toMatch(/from\s+['"]\.\/card-variants['"]/);
        // The primitive exports both surfaces.
        expect(src).toMatch(/export\s*\{\s*[^}]*\bCard\b[^}]*\}/);
        expect(src).toMatch(/export\s*\{\s*[^}]*\bcardVariants\b[^}]*\}/);
    });

    it('no .tsx file under src/ uses the glass-card literal in non-comment JSX', () => {
        const offenders: Offence[] = [];
        for (const abs of SCANNED) {
            const rel = path.relative(ROOT, abs);
            const raw = fs.readFileSync(abs, 'utf-8');
            // Strip block + line comments first so JSDoc / inline
            // // comments referencing glass-card don't trip.
            const stripped = blankNonCode(raw);
            const lines = stripped.split('\n');
            lines.forEach((line, i) => {
                if (/\bglass-card\b/.test(line)) {
                    offenders.push({
                        file: rel,
                        line: i + 1,
                        snippet: line.trim().slice(0, 200),
                    });
                }
            });
        }
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `These files reach for the legacy glass-card literal directly. Use <Card density="..." elevation="..."> for plain divs or cardVariants({...}) for non-div consumers:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});

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

const ROOT = path.resolve(__dirname, '../..');
const PRIMITIVE = 'src/components/ui/card.tsx';
const VARIANTS = 'src/components/ui/card-variants.ts';

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
                if (rel === PRIMITIVE) continue;
                const raw = fs.readFileSync(full, 'utf-8');
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
        };
        walk(path.join(ROOT, 'src'));
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

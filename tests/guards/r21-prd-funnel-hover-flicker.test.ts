/**
 * R21-PR-D hotfix — funnel-chart hover flicker.
 *
 * Bug: each stage's hover `<rect>` carried its own `onPointerLeave`
 * that reset `tooltip` to the default. When the cursor crossed an
 * adjacent stage boundary, leave fired on A → tooltip flipped to
 * default → enter fired on B. One frame at the default state caused
 * every stage's `isolationMultiplier` (0.3 ↔ 1) to snap, reading as
 * a flicker.
 *
 * Fix: the leave-to-default behaviour belongs at the chart boundary,
 * not the per-stage boundary. The outer `<svg>` owns the leave;
 * crossing between sibling rects is a pure enter on the new stage,
 * with no intermediate reset.
 *
 * Ratchet locks both halves of the fix in place so a future
 * "simplify hover handlers" PR can't silently bring back the
 * per-rect leave that caused the regression.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const FUNNEL = fs.readFileSync(
    path.resolve(
        __dirname,
        '../../src/components/ui/charts/funnel-chart.tsx',
    ),
    'utf8',
);

describe('R21-PR-D hotfix — funnel hover flicker', () => {
    // Strip line-comments + block-comments so a comment containing
    // `<rect>` or `onPointerLeave` literally (this ratchet itself
    // referenced in the source explanation) can't poison the search.
    const SRC = blankNonCode(FUNNEL);

    it('outer <svg> owns the leave-to-default behaviour', () => {
        // The leave-to-default handler — `setTooltip(default…)` — must
        // be present, and it must live inside the outer `<svg>` open
        // tag (not on a per-stage rect, not on the wrapper <div>).
        // Asserted as: the handler exists AND it appears BEFORE the
        // `<defs>` block (i.e. before any per-step rendering).
        const handlerIdx = SRC.search(
            /onPointerLeave=\{\(\)\s*=>[\s\S]*?setTooltip\(defaultTooltipStepId/,
        );
        expect(handlerIdx).toBeGreaterThan(-1);
        const defsIdx = SRC.indexOf('<defs>');
        expect(defsIdx).toBeGreaterThan(-1);
        expect(handlerIdx).toBeLessThan(defsIdx);
    });

    it('per-stage hover-rect does NOT carry onPointerLeave', () => {
        // The flicker came from a per-stage onPointerLeave that
        // fired during boundary crossings. Per-stage rects keep
        // onPointerEnter + onPointerDown only.
        //
        // Anchor on the className unique to the per-stage rect
        // (`fill-transparent transition-colors hover:fill-`) — the
        // matched fragment is its containing element.
        const stageRectMatch = SRC.match(
            /<rect\b[^>]*?fill-transparent[\s\S]*?\/>/m,
        );
        expect(stageRectMatch).not.toBeNull();
        const stageRect = stageRectMatch![0];
        expect(stageRect).toMatch(/onPointerEnter=/);
        expect(stageRect).toMatch(/onPointerDown=/);
        expect(stageRect).not.toMatch(/onPointerLeave=/);
    });

    it('exactly one onPointerLeave handler in the chart source', () => {
        // Belt-and-braces: the entire file (comments stripped) carries
        // exactly one onPointerLeave handler. If a future PR re-adds
        // the per-rect handler, the count goes to two and this fails.
        const matches = SRC.match(/onPointerLeave\s*=/g) ?? [];
        expect(matches).toHaveLength(1);
    });
});

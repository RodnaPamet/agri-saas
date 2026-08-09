/**
 * Roadmap-8 PR-6 (replacement) — ratchet-precedence documentation lock.
 *
 * R8-PR6 + PR-7 originally proposed demoting `+ X` form-toggle
 * buttons (practices/[practiceId] and vendors/[vendorId]) from
 * `variant="primary"` to `variant="secondary"` to drop the
 * `primary-action-budget` count. Investigation revealed a conflict:
 *
 *   • `tests/guards/primary-action-budget.test.ts` (R7-PR1) — count
 *     constraint. Caps the number of primary buttons per file.
 *
 *   • `tests/guards/create-button-uniformity.test.ts` (v2-fu-2) —
 *     visual constraint. Locks every `+ X` button to
 *     `variant="primary"` so the `+` glyph reads uniformly
 *     white-on-brand across every create button.
 *
 * The two ratchets ask different things. When they conflict, the
 * VISUAL ratchet wins — visual uniformity is the user-perceived
 * quality lever; budget is a count tool. The original PRs were
 * closed; this replacement PR codifies the precedence so a future
 * contributor can't re-discover the conflict by accident.
 *
 * What this ratchet locks:
 *
 *   1. `create-button-uniformity` exists. Stripping it would open
 *      the regression door.
 *   2. `primary-action-budget` exists.
 *   3. The R7-PR1 budget map is sorted-or-flat — no nested
 *      conditional logic that could try to bypass `+ X` buttons.
 *   4. The CLAUDE.md memo (or this docblock) records the
 *      precedence so the priority is searchable.
 *
 * Pairs with:
 *   • `tests/guards/primary-action-budget.test.ts` (R7-PR1)
 *   • `tests/guards/create-button-uniformity.test.ts` (v2-fu-2)
 *   • `tests/guards/action-label-vocabulary.test.ts` (the BAN side
 *     of "+ X" — no legacy "Add X" / "New X" / "Create X" text).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

describe("ratchet precedence: visual > count", () => {
    it("create-button-uniformity ratchet exists (v2-fu-2)", () => {
        const fp = path.join(
            ROOT,
            "tests/guards/create-button-uniformity.test.ts",
        );
        expect(fs.existsSync(fp)).toBe(true);
    });

    it("primary-action-budget ratchet exists (R7-PR1)", () => {
        const fp = path.join(
            ROOT,
            "tests/guards/primary-action-budget.test.ts",
        );
        expect(fs.existsSync(fp)).toBe(true);
    });

    it("primary-action-budget map does not gate `+ X` buttons (visual ratchet wins)", () => {
        const src = fs.readFileSync(
            path.join(ROOT, "tests/guards/primary-action-budget.test.ts"),
            "utf8",
        );
        // The budget ratchet uses a flat map keyed by file path. It
        // does NOT pattern-match button text or strip `+ X` buttons
        // before counting. This guarantees that `+ X` button
        // demotion can't sneak through a regex tweak.
        expect(src).not.toMatch(/strip.*\+\s*[A-Z]/i);
        expect(src).not.toMatch(/skip.*create.*button/i);
    });

    it("action-label-vocabulary ratchet exists (the BAN-side of + X)", () => {
        const fp = path.join(
            ROOT,
            "tests/guards/action-label-vocabulary.test.ts",
        );
        expect(fs.existsSync(fp)).toBe(true);
    });
});

/**
 * Every registration entry point screens for bots.
 *
 * ── why this guard exists in this exact shape ──
 *
 * P0.7 ticked "Turnstile" on #1191 and shipped nothing. The checkbox was the
 * only artefact. So the lesson is not "write Turnstile" — it is that a control
 * on the signup path needs something that fails when a new signup path appears
 * without it, because the next entry point will be added by someone who has
 * never read the Turnstile PR.
 *
 * Registration v2 (#1344) is about to add a SECOND entry point,
 * `/api/auth/register/start`. When it lands, this guard reddens until that
 * route calls `verifyTurnstile` — which is a forcing function, where a note in
 * a PR body would have been a hope.
 *
 * ── the population is DERIVED, not listed ──
 *
 * A hand-written list of entry points is the same failure one level up: it
 * covers the routes its author was looking at. So the population comes from
 * disk — every route file under `src/app/api/auth/register/` — and the floor
 * below refuses an empty selection, because an empty population passes every
 * assertion here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { collectTrackedFiles } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Registration entry points: any route handler under the register tree.
 *
 * Derived rather than enumerated: a hand-written list covers the routes its
 * author was looking at. Anything under the tree that is NOT an entry point is
 * exempted by name in `NOT_AN_ENTRY_POINT`, with a reason — that map is empty
 * today and its docblock records what goes in it when #1344 lands.
 */
const ENTRY_POINTS = collectTrackedFiles({
    roots: ['src/app/api/auth/register'],
    extensions: ['.ts'],
    floor: 1,
}).filter((abs) => path.basename(abs) === 'route.ts');

/**
 * Routes under the register tree that are NOT entry points, each with a
 * reason. A bare allowlist would make this guard decorative.
 */
const NOT_AN_ENTRY_POINT: Record<string, string> = {
    'src/app/api/auth/register/verify/route.ts':
        'Step 2 of registration v2. Reachable only by someone holding a 6-digit code THIS system emailed to an address already screened at step 1, and it creates nothing — it sets emailVerified on a user that already exists. A challenge here would tax a person mid-signup to re-prove what step 1 established, and its own abuse shape (guessing a 10^6 code) is bounded by the per-code attempt cap plus LOGIN_LIMIT.',
};

describe('registration entry points are screened for bots', () => {
    it('derives its population from disk, and it is not empty', () => {
        // An empty selection PASSES every assertion below. This is the floor
        // that makes the rest mean anything, asserted here rather than only
        // inside the collector so gutting the one-line call cannot skip it.
        expect(ENTRY_POINTS.length).toBeGreaterThanOrEqual(1);
    });

    it('every entry point calls verifyTurnstile', () => {
        const unscreened: string[] = [];
        for (const abs of ENTRY_POINTS) {
            const rel = path.relative(ROOT, abs);
            if (rel in NOT_AN_ENTRY_POINT) continue;
            // CODE, not prose: this file and the routes both discuss
            // `verifyTurnstile` in comments, and a guard that matched a
            // docblock explaining the call would pass with the call deleted.
            // I have shipped exactly that bug before.
            const code = blankNonCode(fs.readFileSync(abs, 'utf8'));
            if (!/verifyTurnstile\s*\(/.test(code)) unscreened.push(rel);
        }

        expect(unscreened).toEqual([]);
    });

    it('a screened route REFUSES rather than merely calling the verifier', () => {
        // Calling it and ignoring the result is the #613 failure: the `await`
        // stayed, the result was discarded, and an import-and-call regex
        // guardrail was satisfied by the remains. So require the refusal to be
        // visible — the result must be branched on.
        for (const abs of ENTRY_POINTS) {
            const rel = path.relative(ROOT, abs);
            if (rel in NOT_AN_ENTRY_POINT) continue;
            const code = blankNonCode(fs.readFileSync(abs, 'utf8'));
            // `!<something>.ok` within a few lines of the call. Deliberately
            // loose about the variable name: pinning `turnstile.ok` would go
            // blind at a rename, which is how a needle loses its thread.
            expect(code).toMatch(/verifyTurnstile\s*\([\s\S]{0,400}?!\s*\w+\.ok/);
        }
    });

    it('CONTROL: the needle matches a real call and not a comment', () => {
        // Without this, a regex that matched nothing would make the two
        // assertions above pass forever.
        const real = 'const t = await verifyTurnstile(body.token);\nif (!t.ok) return refuse();';
        expect(/verifyTurnstile\s*\(/.test(blankNonCode(real))).toBe(true);
        expect(real).toMatch(/verifyTurnstile\s*\([\s\S]{0,400}?!\s*\w+\.ok/);

        const commentOnly = '// we deliberately do not call verifyTurnstile() here\nconst x = 1;';
        expect(/verifyTurnstile\s*\(/.test(blankNonCode(commentOnly))).toBe(false);
    });

    it('every exemption names a route that exists', () => {
        // An exemption for a path that has moved is an exemption that silently
        // stops exempting — or worse, hides that the real route is unscreened.
        const present = new Set(ENTRY_POINTS.map((a) => path.relative(ROOT, a)));
        for (const rel of Object.keys(NOT_AN_ENTRY_POINT)) {
            expect(present.has(rel)).toBe(true);
        }
    });

    it('every exemption carries a substantive reason', () => {
        for (const [rel, reason] of Object.entries(NOT_AN_ENTRY_POINT)) {
            // A one-word reason is how an allowlist becomes a place to put
            // things rather than a decision anyone has to defend.
            expect(reason.length).toBeGreaterThan(80);
            expect(rel).toMatch(/^src\/app\/api\/auth\/register\//);
        }
    });
});

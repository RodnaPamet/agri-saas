/**
 * No unbounded Earth Engine call may re-enter `earth-engine.ts`.
 *
 * The behavioural half lives in
 * `tests/unit/agro/earth-engine-hang-is-bounded.test.ts`, which drives a silent
 * EE and asserts the deadline fires. That proves the FIVE call sites that exist
 * today. This file is the ratchet for the SIXTH — a new EE round-trip added
 * later, wrapped in a bare `new Promise`, which the behavioural test would not
 * exercise and so would not catch.
 *
 * The invariant is deliberately crude and therefore hard to satisfy by
 * accident: `withEeDeadline` holds the only `new Promise` in the module, so
 * every promisified callback must go through it. "One" is a far better
 * assertion than "N or fewer" — a budget with slack is a budget the next
 * unbounded call fits inside.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { blankNonCode } from '../helpers/blank-non-code';

const REL = 'src/lib/agro/earth-engine.ts';
const SRC = fs.readFileSync(path.resolve(__dirname, '../..', REL), 'utf8');

/**
 * The source with comments removed.
 *
 * Load-bearing: the helper's own docblock explains why it is the only
 * `new Promise`, and a guard that counted prose would trip on its own
 * explanation — the same way an assertion banning a word fails on the comment
 * describing it.
 */
function code(src: string): string {
    // One state-aware pass replaces the block strip plus the per-line `//`
    // strip. The flagless `/\/\/.*$/` was correct only because it ran inside
    // a `.map` over lines — a detail a reader has to reconstruct (#1605).
    return blankNonCode(src);
}

const CODE = code(SRC);

describe('every Earth Engine round-trip is bounded', () => {
    it('control: the file was read and is the one we mean', () => {
        // Without this every assertion below passes on an empty string.
        expect(SRC.length).toBeGreaterThan(5_000);
        expect(SRC).toContain('withEeDeadline');
        expect(SRC).toContain('EE_INIT_TIMEOUT_MS');
        expect(CODE).toContain('export async function getIndexTileUrl');
        // ...and the comment stripper kept the code while dropping prose.
        expect(CODE).not.toContain('Load-bearing');
        // Length is PRESERVED, not reduced: `blankNonCode` overwrites comment
        // characters with spaces rather than deleting them (#1605). This read
        // `toBeLessThan` and measured DELETION as the proof the stripper ran —
        // the fourth control in this repo with that shape, and the reason
        // #1588's conversion broke three others.
        //
        // The substantive check is the `not.toContain` above. This one now
        // pins the property that makes every offset this guard reports line up
        // with the real file.
        expect(CODE.length).toBe(SRC.length);
        expect(CODE).not.toBe(SRC);
    });

    it('`withEeDeadline` holds the ONLY `new Promise` in the module', () => {
        const sites = CODE.match(/new Promise\b/g) ?? [];
        if (sites.length !== 1) {
            throw new Error(
                `Expected exactly 1 \`new Promise\` in ${REL}, found ${sites.length}.\n\n` +
                    'Every EE round-trip is a callback API. A promise wrapper with no ' +
                    'deadline never settles when the callback is never invoked, and a HANG ' +
                    'IS NOT A THROW — the `try/catch` here and the soft `generation_failed` ' +
                    "arm in index-tiles-handler.ts both miss it, so the user's request never " +
                    'completes and all five index buttons fail together.\n\n' +
                    'Wrap the new call in `withEeDeadline(label, budget, (resolve, reject) => …)` ' +
                    'instead of `new Promise`.',
            );
        }
        // And it is the helper's, not somewhere else.
        expect(CODE).toMatch(/function withEeDeadline[\s\S]{0,400}?new Promise/);
    });

    it('both budgets are real numbers, and small enough to matter', () => {
        // A deadline longer than a browser waits buys nothing: the point is to
        // return the honest "couldn't load imagery" state while the user is
        // still looking at the map.
        const init = CODE.match(/EE_INIT_TIMEOUT_MS\s*=\s*([0-9_]+)/);
        const call = CODE.match(/EE_CALL_TIMEOUT_MS\s*=\s*([0-9_]+)/);
        expect(init).not.toBeNull();
        expect(call).not.toBeNull();
        const initMs = Number(init![1].replace(/_/g, ''));
        const callMs = Number(call![1].replace(/_/g, ''));
        expect(initMs).toBeGreaterThan(0);
        expect(callMs).toBeGreaterThan(0);
        expect(initMs).toBeLessThanOrEqual(15_000);
        expect(callMs).toBeLessThanOrEqual(30_000);
    });

    it('every EE callback entry point is inside a bounded wrapper', () => {
        // Derived from the EE API surface rather than a hand list, so a new
        // call style still has to answer for itself.
        const entries = ['.evaluate(', '.getMap(', 'authenticateViaPrivateKey('];
        const present = entries.filter((e) => CODE.includes(e));
        // Positive control: these are the shapes this module actually uses.
        expect(present.length).toBeGreaterThanOrEqual(3);

        for (const entry of present) {
            let from = 0;
            for (;;) {
                const at = CODE.indexOf(entry, from);
                if (at === -1) break;
                from = at + entry.length;
                // Walk back to the nearest wrapper opening; `withEeDeadline`
                // must be the closest one, not merely present in the file.
                const before = CODE.slice(0, at);
                const lastDeadline = before.lastIndexOf('withEeDeadline');
                const lastBare = before.lastIndexOf('new Promise');
                expect(lastDeadline).toBeGreaterThan(-1);
                expect(lastDeadline).toBeGreaterThan(lastBare);
            }
        }
    });
});

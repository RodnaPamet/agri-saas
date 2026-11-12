import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';

/*
 * A streamed answer's RESTART must be declared, not inferred.
 *
 * `createPrefixReleaser().observe()` turns an empty cumulative into
 * `restarted: true`, and `routing.ts` is what produces one — once per
 * attempt, before the call runs. Inferring a restart from "the next value
 * is shorter" is wrong in the one direction that corrupts an answer: a
 * fresh attempt whose first chunk clears everything the previous attempt
 * released reads as growth, so the client appends a mid-sentence slice of
 * the new answer to the old one and is never told to discard.
 *
 * This is asserted on the SOURCE because nothing in the repo drives the
 * real `completeWithRouting` — every suite that reaches it mocks it, so a
 * behavioural test here would be grading its own double. The behaviour on
 * the other side of the seam IS executed: `assistant-stream-route` drives
 * the route with the sequence routing produces, and
 * `prefix-release-is-sound` drives the releaser.
 */
const ROUTING = join(process.cwd(), 'src/app-layer/ai/routing.ts');

describe('a streamed restart is declared by routing', () => {
    /*
     * Comments blanked, strings KEPT (`strings: false`): the anchors below
     * are `''` literals, and blanking strings removes the quotes with the
     * contents, so every needle here would match nothing and the guard
     * would report an absence it had created. Comments are the real hazard
     * anyway — this file's own prose names the call it looks for.
     */
    const code = blankNonCode(readFileSync(ROUTING, 'utf8'), { strings: false });

    it('declares an empty cumulative once per attempt, inside the retry loop', () => {
        const lines = code.split('\n');
        const loop = lines.findIndex((l) => /for \(let attempt = 0/.test(l));
        const declare = lines.findIndex((l) => /onTextProgress\?\.\(''\)/.test(l));
        const call = lines.findIndex((l) => /await completeOnce</.test(l));

        // A positive control: the three anchors still exist. Without it a
        // renamed loop variable makes every comparison below -1 < -1.
        expect(loop).toBeGreaterThan(-1);
        expect(declare).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(-1);

        // Inside the loop, so a retry re-declares; before the call, so the
        // declaration cannot arrive after the first delta of the new text.
        expect(declare).toBeGreaterThan(loop);
        expect(declare).toBeLessThan(call);
        expect(code.match(/onTextProgress\?\.\(''\)/g)).toHaveLength(1);
    });

    it('the accumulator is per attempt, so two answers cannot concatenate', () => {
        const lines = code.split('\n');
        const loop = lines.findIndex((l) => /for \(let attempt = 0/.test(l));
        const accumulator = lines.findIndex((l) => /let streamedRaw = ''/.test(l));
        expect(accumulator).toBeGreaterThan(loop);
        expect(code.match(/let streamedRaw = ''/g)).toHaveLength(1);
    });
});

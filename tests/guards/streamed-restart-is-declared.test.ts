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

/**
 * Where each anchor sits, as line numbers — and a MODULE-LEVEL function
 * because that is what makes the selection auditable.
 *
 * `Selector teeth` reaches a named selector at module or describe level and
 * cannot reach one that happens inline inside `it()`; a guard in the second
 * shape passes whether or not it selects anything. The first draft of this
 * file was in that shape and pushed the unauditable-guard count from 200 to
 * 201, which is how CI said so. Extracting it is also what makes the
 * positive control below possible.
 *
 * Comments are blanked and strings are KEPT: the anchors are `''` literals,
 * and blanking strings removes the quotes with the contents, so every needle
 * would match nothing and the guard would report an absence it had created.
 * Comments are the real hazard anyway — this file's own prose names the call
 * it looks for.
 */
export function anchorLines(src: string): {
    loop: number;
    declare: number;
    call: number;
    accumulator: number;
} {
    const lines = blankNonCode(src, { strings: false }).split('\n');
    const find = (re: RegExp): number => lines.findIndex((l) => re.test(l));
    return {
        loop: find(/for \(let attempt = 0/),
        declare: find(/onTextProgress\?\.\(''\)/),
        call: find(/await completeOnce</),
        accumulator: find(/let streamedRaw = ''/),
    };
}

/** How many times a needle occurs in code, comments blanked. */
export function codeOccurrences(src: string, re: RegExp): number {
    return blankNonCode(src, { strings: false }).match(re)?.length ?? 0;
}

describe('a streamed restart is declared by routing', () => {
    const src = readFileSync(ROUTING, 'utf8');

    it('declares an empty cumulative once per attempt, inside the retry loop', () => {
        const at = anchorLines(src);

        // Positive control: every anchor still resolves. Without it a renamed
        // loop variable makes each comparison below -1 < -1, and the guard
        // passes by having found nothing.
        expect(at.loop).toBeGreaterThan(-1);
        expect(at.declare).toBeGreaterThan(-1);
        expect(at.call).toBeGreaterThan(-1);

        // Inside the loop, so a retry re-declares; before the call, so the
        // declaration cannot arrive after the first delta of the new text.
        expect(at.declare).toBeGreaterThan(at.loop);
        expect(at.declare).toBeLessThan(at.call);
        expect(codeOccurrences(src, /onTextProgress\?\.\(''\)/g)).toBe(1);
    });

    it('the accumulator is per attempt, so two answers cannot concatenate', () => {
        const at = anchorLines(src);
        expect(at.accumulator).toBeGreaterThan(at.loop);
        expect(at.accumulator).toBeLessThan(at.call);
        expect(codeOccurrences(src, /let streamedRaw = ''/g)).toBe(1);
    });

    it('the selector can tell a declaration from its absence', () => {
        // The control the extraction exists for: prove the needle resolves on
        // a source that HAS the call and not on one that merely discusses it.
        const withCall = ['for (let attempt = 0; ;) {', "    opts.onTextProgress?.('');", '    await completeOnce<T>(', '}'].join('\n');
        const commentOnly = ['for (let attempt = 0; ;) {', "    // opts.onTextProgress?.('') belongs here", '    await completeOnce<T>(', '}'].join('\n');

        expect(anchorLines(withCall).declare).toBeGreaterThan(-1);
        expect(anchorLines(commentOnly).declare).toBe(-1);
    });
});

/**
 * The stream drain must run BEFORE the handler's first `await` — P7.3 (#1992).
 *
 * ## Why this is a guard and not just a unit test
 *
 * `installShutdownHandlers` has four stages and only one of them reliably
 * runs. Node invokes every signal listener synchronously, in registration
 * order, inside one `emit`; `next start` registers its own listener whose work
 * sits in an `async` IIFE ending in `process.exit(143)`. So anything this
 * handler does before its first `await` completes, and anything after it is
 * racing that exit — a race measured in production over 7 days as 58
 * `graceful shutdown initiated` against 1 `graceful shutdown complete`
 * (#2091).
 *
 * The drain is therefore correct only as long as it stays above the first
 * `await`. Moving it one line down — below the audit flush, say, which reads
 * as tidier because the stages are numbered — silently converts a working
 * drain into one that loses the same race, and no behavioural test fails:
 * under jest there is no competing listener calling `process.exit`, so an
 * awaited drain still completes. The defect is invisible except in production.
 *
 * Hence a source-order assertion. It is the shape of defect a guard exists
 * for: a reordering that is harmless in every environment except the one that
 * matters.
 */
import * as fs from 'fs';
import * as path from 'path';

import { blankNonCode } from '../helpers/blank-non-code';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SHUTDOWN = path.join(REPO_ROOT, 'src/lib/observability/shutdown.ts');

/**
 * Comments stripped before any position is compared.
 *
 * The docblock explains the await/exit race at length and names `await` and
 * `drainOpenStreams` while doing so, so an index computed over raw source
 * would be measuring prose. `blankNonCode` is state-aware and preserves
 * offsets, which is what lets the positions below still mean something —
 * a local block-then-line stripper is the defect
 * `tests/guards/comment-stripper-order.test.ts` forbids.
 */
const code = blankNonCode(fs.readFileSync(SHUTDOWN, 'utf8'));

describe('the SIGTERM stream drain is synchronous', () => {
    it('the file still contains both things being compared', () => {
        // Without this, every assertion below passes vacuously on a file that
        // was renamed, emptied, or had the drain removed altogether.
        expect(code).toContain('drainOpenStreams(');
        expect(code).toMatch(/\bawait\b/);
        expect(code).toContain("process.once('SIGTERM'");
    });

    it('calls the drain BEFORE the first await', () => {
        const drain = code.indexOf('drainOpenStreams(');
        const firstAwait = code.search(/\bawait\b/);

        expect(drain).toBeGreaterThan(-1);
        expect(firstAwait).toBeGreaterThan(-1);
        expect(drain).toBeLessThan(firstAwait);
    });

    it('does not await the drain itself', () => {
        // `await drainOpenStreams()` would be the same defect spelled
        // differently: the call site stays first and the work still lands
        // after a yield to the microtask queue, by which time Next's handler
        // may already have exited.
        expect(code).not.toMatch(/await\s+drainOpenStreams/);
        expect(code).not.toMatch(/void\s+drainOpenStreams/);
    });

    it('the drain is reachable from the signal, not just imported', () => {
        // `existing is not mounted`: an import plus a function nobody calls
        // from the handler would satisfy every assertion above if the call
        // sat in a helper that the listener never reaches.
        const handlerStart = code.indexOf('const handler =');
        const handlerEnd = code.indexOf("process.once('SIGTERM'");

        expect(handlerStart).toBeGreaterThan(-1);
        expect(handlerEnd).toBeGreaterThan(handlerStart);
        expect(code.slice(handlerStart, handlerEnd)).toContain('drainOpenStreams(');
    });

    it('the detector has teeth, on synthetic sources', () => {
        const GOOD = `const handler = async (s) => {\n  drainOpenStreams();\n  await flush();\n};`;
        const MOVED = `const handler = async (s) => {\n  await flush();\n  drainOpenStreams();\n};`;
        const AWAITED = `const handler = async (s) => {\n  await drainOpenStreams();\n};`;
        const COMMENT_ONLY = `const handler = async (s) => {\n  // drainOpenStreams() belongs here\n  await flush();\n};`;

        const drainIsFirst = (src: string) => {
            const c = blankNonCode(src);
            const d = c.indexOf('drainOpenStreams(');
            const a = c.search(/\bawait\b/);
            return d > -1 && a > -1 && d < a;
        };
        const awaitsDrain = (src: string) => /await\s+drainOpenStreams/.test(blankNonCode(src));

        expect(drainIsFirst(GOOD)).toBe(true);
        expect(drainIsFirst(MOVED)).toBe(false);
        expect(awaitsDrain(AWAITED)).toBe(true);
        expect(awaitsDrain(GOOD)).toBe(false);
        // The case that makes the comment-stripping load-bearing: a file that
        // only MENTIONS the call would otherwise read as calling it first.
        expect(drainIsFirst(COMMENT_ONLY)).toBe(false);
    });
});

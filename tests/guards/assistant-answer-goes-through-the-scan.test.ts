/**
 * An assistant answer cannot reach a client without the egress scan — #2578.
 *
 * ## Why this is a choke-point count and not a hunt for unscanned sites
 *
 * #2578 records the gap: `scanEgress` shipped with no caller, and when it got
 * one it needed a COVERAGE control, because "the stream route calls it, done"
 * is the reading that left `enforceApiKeyScope` covering 23 of 273 routes.
 *
 * A guard that hunts for emit sites lacking a nearby scan has to enumerate the
 * shapes outgoing text can take — an SSE event, a non-streaming fallback, a
 * refusal quoting retrieved content, the `links` field — and the one it has not
 * thought of is the one that ships. So the property enforced here is stronger
 * and cheaper to check: **the event has exactly one construction site, and
 * that site scans.** A second site is a diff somebody has to justify.
 *
 * ## It lands BEFORE the tool loop on purpose
 *
 * Every tool result is farm data entering an answer, so the number of ways
 * text can reach a client is about to grow. A control written after that
 * growth is written against the paths that already exist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';

const CHOKE_POINT = 'src/app-layer/ai/assistant/emit-answer.ts';

/**
 * Every `src/` file, with comments blanked — and the blanking is load-bearing
 * rather than ceremony here, provably: `emit-answer.ts`'s own docblock says
 * "`{ type: 'answer'` is spelled HERE and nowhere else", and
 * `assistant-answer-goes-through-the-scan.test.ts` (this file) quotes the
 * token repeatedly to explain itself. Unblanked, the guard would report both
 * as construction sites and the count would never be 1.
 *
 * Strings are NOT blanked: `'answer'` is a string literal, so blanking them
 * would erase the thing being counted.
 */
const FILES = collectSourceFiles({ roots: ['src'], extensions: ['.ts', '.tsx'], floor: 500 });

const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/** Files whose CODE constructs an `answer` stream event. */
function constructionSites(): string[] {
    return FILES.filter((abs) =>
        /\{\s*type:\s*'answer'/.test(blankNonCode(readFileSync(abs, 'utf8'))),
    ).map(rel);
}

const SITES = constructionSites();

describe('the assistant answer choke point (#2578)', () => {
    it('ranges over a real population', () => {
        console.log(
            `[assistant-egress] ${FILES.length} src file(s) scanned; `
                + `${SITES.length} construct an answer event`,
        );
        expect(FILES.length).toBeGreaterThanOrEqual(500);
    });

    it('exactly ONE file constructs an answer event, and it is the choke point', () => {
        expect(SITES).toEqual([CHOKE_POINT]);
    });

    it('the choke point scans, and scans BEFORE it sends', () => {
        const code = blankNonCode(readFileSync(path.join(REPO_ROOT, CHOKE_POINT), 'utf8'));
        expect(code).toMatch(/scanEgress\s*\(/);
        // Order, by position. The behavioural proof is in
        // `tests/unit/ai/assistant-emit-answer.test.ts`, which asserts the
        // bytes; this is the cheap structural half, and it is here because a
        // verdict computed after the send is a record rather than a control.
        const scanAt = code.search(/scanEgress\s*\(/);
        const sendAt = code.search(/\{\s*type:\s*'answer'/);
        expect(scanAt).toBeGreaterThan(-1);
        expect(sendAt).toBeGreaterThan(scanAt);
    });

    it('nothing else imports scanEgress — so there is no second policy', () => {
        // A second caller is not wrong in itself, but it would mean a second
        // place deciding what happens on a dirty verdict. One decision:
        // DISCARD, never redact.
        const importers = FILES.filter((abs) =>
            /from\s+'[^']*safety\/egress-scan'/.test(blankNonCode(readFileSync(abs, 'utf8'))),
        ).map(rel);
        expect(importers).toEqual([CHOKE_POINT]);
    });
});

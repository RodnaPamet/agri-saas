/**
 * A client that consumes the assistant stream must read its DISCLOSURES.
 *
 * ## The defect this is built for, which has not happened on the web yet
 *
 * `tool-loop.ts` states a precedence — TIME > TOOL_CALLS > TRUNCATED > PARTIAL
 * — and justifies it with a claim about delivery: "Truncation is additionally
 * always reported on `done.truncatedAny`, so it is never silent even when a
 * higher-precedence halt wins."
 *
 * The EMITTER is faithful: `done` carries the flag on every path. The claim is
 * about the outcome, and the outcome depended on a reader. Measured (#2649):
 *
 *   iOS before agrent-ios#497  — no: it stopped reading at the halt, so a
 *                                `done` after one was dropped unread
 *   iOS after #497             — yes
 *   web                        — no assistant UI exists at all
 *   anything else in `src/`    — none
 *
 * So since the flag was introduced, a turn that truncated a result AND hit a
 * higher-precedence halt disclosed nothing to anybody. `wired-is-not-delivered`
 * with an unusual feature: the server side is correct and complete, and the
 * chain broke at the last hop.
 *
 * ## Why a guard and not only a note
 *
 * #2649 proposed a note, on the ground that a guard over code that does not
 * exist is pointless. The precedent says otherwise:
 * `social-routes-flag-gated` has a population of ZERO until P2 and is built
 * for that — it prints its denominator, proves its detector against synthetic
 * sources, and becomes a gate the moment a real surface appears.
 *
 * That is the right shape here, because the failure mode is a web assistant
 * being built MONTHS from now by somebody who reads the docblock's claim and
 * reasonably believes the disclosure is handled. A note is read by whoever
 * looks; a guard fires on the diff that creates the problem.
 */
import { readFileSync } from 'fs';
import path from 'path';

import { collectSourceFiles, REPO_ROOT } from '../helpers/collect-files';
import { blankNonCode } from '../helpers/blank-non-code';

/**
 * What makes a file a CONSUMER of the assistant stream.
 *
 * Two independent signals, because either alone misses a real consumer: a
 * component could hand-roll the fetch without importing our event types, or
 * import the types while fetching through a helper.
 */
const CONSUMER_SIGNALS = [
    'assistant/stream',
    'AssistantStreamEvent',
    "from '@/app-layer/ai/assistant/stream-events'",
];

/**
 * The fields a consumer must reference. Each is disclosure-bearing — a client
 * that renders an answer without them tells a person something incomplete is
 * complete, or shows an advert without its legally required wording.
 */
const DISCLOSURES = ['truncatedAny', 'partialAny', 'safetyWording'];

/** Reads the stream but is not a client surface. */
const NOT_A_CLIENT: ReadonlyArray<{ file: string; why: string }> = [
    {
        file: 'src/app/api/t/[tenantSlug]/assistant/stream/route.ts',
        why: 'the EMITTER. It writes the fields; it has nothing to read them for.',
    },
];

/*
 * Comments are blanked; STRING LITERALS ARE NOT, and that is load-bearing.
 *
 * The first version of this guard passed `{ strings: true }`, which blanks
 * string and template literals — and then searched for `assistant/stream`,
 * a signal that only ever appears INSIDE a string. So a real consumer
 * (`fetch(`/api/t/${slug}/assistant/stream`)`) was invisible: the scan found
 * zero consumers while the synthetic detector control passed, because the
 * control never went through `blankNonCode`.
 *
 * Found by mutation — dropping a genuinely offending component into
 * `src/components` changed nothing. It is the inverse of the usual trap:
 * normally you strip comments so a docblock DESCRIBING a pattern is not
 * reported as using it; here stripping went one step further and removed the
 * evidence.
 *
 * Comments still go, for that usual reason: this file's own docblock names
 * `assistant/stream` and must not match itself.
 */
function isConsumer(code: string): boolean {
    return CONSUMER_SIGNALS.some((s) => code.includes(s));
}

describe('an assistant-stream consumer reads the disclosures (#2649)', () => {
    /*
     * CLIENT code only. The server emits these fields and must not be asked to
     * read them, and a test under `tests/` naming them is not a consumer
     * either — which is why the roots are the two client trees rather than
     * `src`.
     */
    const files = collectSourceFiles({
        roots: ['src/components', 'src/app'],
        floor: 100,
    });

    it('the population is printed, because today it is EMPTY', () => {
        const consumers = files
            .map((f) => ({ rel: path.relative(REPO_ROOT, f), code: blankNonCode(readFileSync(f, 'utf8')) }))
            .filter(({ rel, code }) => isConsumer(code) && !NOT_A_CLIENT.some((e) => e.file === rel))
            .map(({ rel }) => rel);

        console.log(
            `[assistant-stream-consumers] ${files.length} client file(s) scanned, `
                + `${consumers.length} consumer(s): ${consumers.join(', ') || '(none — no web assistant UI yet)'}`,
        );
        // No assertion on the count. Zero is the CORRECT answer today and the
        // reason this guard exists; a floor would make it fail on a true state.
        expect(Array.isArray(consumers)).toBe(true);
    });

    it('the detector matches a consumer that forgets, and not one that reads', () => {
        /*
         * The positive control, and it is the whole guard while the population
         * is empty: a scan over zero files is indistinguishable from a scan
         * whose matcher stopped working. Synthetic sources, because there is no
         * real consumer to point at.
         */
        const forgets = `
            const res = await fetch('/api/t/acme/assistant/stream');
            for await (const e of events) { if (e.type === 'halt') show(e.message); }
        `;
        const reads = `
            const res = await fetch('/api/t/acme/assistant/stream');
            for await (const e of events) {
                if (e.type === 'done' && (e.truncatedAny || e.partialAny)) warn();
                if (e.type === 'answer') render(e.promotions, (p) => p.safetyWording);
            }
        `;
        expect(isConsumer(forgets)).toBe(true);
        expect(missingDisclosures(forgets)).toEqual(DISCLOSURES);
        expect(isConsumer(reads)).toBe(true);
        expect(missingDisclosures(reads)).toEqual([]);

        // And a file that is not a consumer at all is never examined.
        expect(isConsumer('const x = 1;')).toBe(false);
    });

    it('every consumer references every disclosure field', () => {
        const offenders: string[] = [];
        for (const abs of files) {
            const rel = path.relative(REPO_ROOT, abs);
            if (NOT_A_CLIENT.some((e) => e.file === rel)) continue;
            const code = blankNonCode(readFileSync(abs, 'utf8'));
            if (!isConsumer(code)) continue;
            const missing = missingDisclosures(code);
            if (missing.length > 0) offenders.push(`${rel} — does not read: ${missing.join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });
});

/** Which disclosure fields a consumer's code never mentions. */
function missingDisclosures(code: string): string[] {
    return DISCLOSURES.filter((d) => !code.includes(d));
}

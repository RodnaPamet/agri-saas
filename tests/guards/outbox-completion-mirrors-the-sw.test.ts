/**
 * Guard: all THREE outbox drains honour a `completeWhen` expectation (#1870).
 *
 * ## Why three
 *
 * One queue, three senders, and they are kept in lockstep by hand:
 *
 *   1. `src/lib/offline/use-offline-sync.ts` — `submit`, the online-first
 *      attempt, before anything is queued.
 *   2. `src/lib/offline/sync.ts` — `flushOutbox`, the page drain.
 *   3. `public/sw.js` — `flushOutbox`, the Background Sync drain. It cannot
 *      import from `src/`: it is served as a static asset and parsed as a
 *      classic worker.
 *
 * `public/sw.js` says so itself, about the 426 arm, two hundred lines above
 * the code this guard checks: *"The two drains share this queue and NOTHING
 * enforces the mirror; they are kept in lockstep by hand."* That sentence was
 * accurate, and #1870 adds a property where being out of lockstep is
 * INVISIBLE rather than merely wrong — a worker that drops an unfinished
 * treatment undoes the page's resume and leaves nothing behind but a delivery
 * receipt, which is exactly the trace that tells the page a drain was
 * deliberate. The register ends short and every signal says it did not.
 *
 * #786 is the precedent: two item literals over one base drifted apart, so
 * `enqueue` stamped attribution and `enqueuePhoto` never had, and every photo
 * queued since replayed under whoever was signed in at flush time. The fix
 * then was one shared helper; here one of the three copies CANNOT share, so
 * the fix is this file.
 *
 * ## What it checks
 *
 * Per site, that the completeness decision is actually consulted — not that
 * the code is identical, which it cannot be. Plus the two directions of the
 * predicate itself, because this is the pair a future reader is most likely
 * to "simplify":
 *
 *   - no expectation  → finished (every existing caller unchanged)
 *   - unevaluable     → NOT finished (retain)
 *
 * That second one is the load-bearing one. Treating an unreadable body as
 * success is the tidying that looks like robustness and silently drops field
 * work out of a compliance register.
 *
 * ## What it does NOT claim
 *
 * That the three behave identically at runtime. It matches source.
 *
 * BOTH drains' behaviour is executed in
 * `tests/unit/offline/outbox-completion-expectation.test.ts` — including the
 * worker's, by loading the real `public/sw.js` through the `new Function`
 * harness `sw-drain-attribution.test.ts` established. I first wrote here that
 * the worker "is not executed anywhere", which was wrong in a way worth
 * leaving on the record: the harness had existed since #761 and I asserted the
 * gap instead of looking for it. `public/sw.js` being imported by nothing does
 * not mean it is unrunnable.
 *
 * What this file still adds over that one is the ONLINE-FIRST `submit` path,
 * which no drain test reaches, and the list itself — a fourth sender is a
 * visible edit here rather than a silent omission from a test nobody thought
 * to extend.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { REPO_ROOT } from '../helpers/collect-files';

import {
    responseSatisfiesExpectation,
    type CompletionExpectation,
} from '@/lib/offline/outbox';

function code(rel: string): string {
    // Blanked: every one of these files DISCUSSES the mechanism at length in
    // prose, and this guard asks whether the mechanism is CALLED. Unblanked,
    // the docblocks alone would satisfy every assertion below — the #1774
    // trap, which has already disarmed one coverage assertion in this repo.
    return blankNonCode(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

const SITES: ReadonlyArray<{ rel: string; consults: RegExp; label: string }> = [
    {
        rel: 'src/lib/offline/use-offline-sync.ts',
        consults: /responseSatisfiesExpectation\s*\(/,
        label: 'the online-first submit',
    },
    {
        rel: 'src/lib/offline/sync.ts',
        consults: /responseSatisfiesExpectation\s*\(/,
        label: 'the page drain',
    },
    {
        rel: 'public/sw.js',
        // A DIFFERENT name on purpose: this one is a hand-kept copy, and a
        // name that matches the import would make a missing mirror look like
        // a shared call.
        consults: /swResponseSatisfiesExpectation\s*\(/,
        label: 'the service-worker drain',
    },
];

describe('every outbox drain honours completeWhen (#1870)', () => {
    it('ranges over all three senders — the denominator', () => {
        // Invisible in CI (#1879), so the length assertion is what holds.
        console.log(`[outbox-completion] ${SITES.length} drain(s): ${SITES.map((s) => s.label).join(', ')}`);
        // Three, and a fourth sender is a deliberate edit to this list rather
        // than a silent exclusion from it.
        expect(SITES).toHaveLength(3);
    });

    it.each(SITES.map((s) => [s.label, s.rel] as const))(
        '%s consults the completeness decision',
        (label, rel) => {
            const site = SITES.find((s) => s.rel === rel);
            if (site === undefined) throw new Error('unreachable');
            if (!site.consults.test(code(rel))) {
                throw new Error(
                    `${rel} (${label}) does not consult a completeWhen expectation.\n\n`
                        + `All three drains share one IndexedDB queue. A sender that treats every\n`
                        + `2xx as delivered will DELETE an item the others are deliberately\n`
                        + `retaining — and leave a delivery receipt, which is the trace the page\n`
                        + `uses to tell a drain apart from an eviction. So the symptom is a\n`
                        + `treatment that reads as recorded while part of it is missing from the\n`
                        + `ДНЕВНИК, with every signal saying it was fine.\n\n`
                        + `POST /journal/treatments is resumable rather than atomic: it can answer\n`
                        + `201 having recorded fewer parcels than were sent.\n\n`
                        + `public/sw.js cannot import from src/, so its copy is by hand. Mirror the\n`
                        + `page drain in src/lib/offline/sync.ts.`,
                );
            }
            expect(site.consults.test(code(rel))).toBe(true);
        },
    );

    it('each drain RETAINS on an unfinished 2xx rather than removing', () => {
        // The removal and the retain are adjacent arms; a mirror that
        // consulted the expectation and then fell through to the removal
        // anyway would satisfy the test above and change nothing. So: the
        // success branch must be guarded by the finished verdict.
        const page = code('src/lib/offline/sync.ts');
        expect(page).toMatch(/res\.ok\s*&&\s*!finished/);
        const sw = code('public/sw.js');
        expect(sw).toMatch(/ok\s*&&\s*!finished/);
        // And the online path must return 'queued', never 'sent', so the
        // caller's optimistic row cannot claim a finished treatment.
        const submit = code('src/lib/offline/use-offline-sync.ts');
        expect(submit).toMatch(/settle\('queued'\)/);
    });

    it('no expectation means a 2xx is delivery — every other caller unchanged', () => {
        // The compatibility direction. If this flipped, every queued write in
        // the product would start being retained.
        expect(responseSatisfiesExpectation(undefined, undefined)).toBe(true);
        expect(responseSatisfiesExpectation(undefined, { anything: 1 })).toBe(true);
    });

    it('an unevaluable expectation means NOT finished — the load-bearing direction', () => {
        const expectation: CompletionExpectation = { field: 'parcelCount', equals: 12 };
        // Satisfied only by the exact number.
        expect(responseSatisfiesExpectation(expectation, { parcelCount: 12 })).toBe(true);
        // Short — the defect #1870 is about.
        expect(responseSatisfiesExpectation(expectation, { parcelCount: 5 })).toBe(false);
        // Over, which should not happen and must not read as finished either.
        expect(responseSatisfiesExpectation(expectation, { parcelCount: 13 })).toBe(false);
        // Every shape of "cannot tell" retains. Treating any of these as
        // success is the tidying that silently drops field work.
        for (const body of [undefined, null, '', 'ok', 0, [], {}, { parcelCount: null },
            { parcelCount: '12' }, { parcelCount: NaN }]) {
            expect(`${JSON.stringify(body) ?? 'undefined'} => ${responseSatisfiesExpectation(expectation, body)}`)
                .toBe(`${JSON.stringify(body) ?? 'undefined'} => false`);
        }
    });

    it('the treatment form is the one caller, and it compares against what it SENT', () => {
        // Named because the expectation is only correct if it is derived from
        // the request. A hardcoded number, or one read off the response, would
        // be satisfied by the very answer it exists to reject.
        const modal = code('src/app/t/[tenantSlug]/(app)/journal/TreatmentEntryModal.tsx');
        expect(modal).toMatch(/completeWhen/);
        expect(modal).toMatch(/field:\s*'parcelCount'/);
        expect(modal).toMatch(/equals:\s*payload\.parcelIds\.length/);
    });
});

/**
 * Guard: the Lighthouse gate MEASURES a throttled paint rather than modelling
 * one (#1980).
 *
 * ## What was wrong
 *
 * `/f/*` failed its 3600ms LCP budget at 3638ms on an i18n commit that cannot
 * reach the page — `errors` is not in `PUBLIC_SURFACE_NAMESPACES`, so those
 * strings live in the `app` bundle and `/f/*` never loads it.
 *
 * Reading the run's artifact rather than its summary table showed why. Every
 * `lhr` stores the SIMULATED metric and the OBSERVED one from the unthrottled
 * trace, and across the five runs of that one job:
 *
 *   simulated LCP   3618 / 4802 / 3638 / 5096 / 2765 ms   spread 2331ms
 *   OBSERVED  LCP    218 /  168 /  177 /  181 /  153 ms   spread   65ms
 *
 * Observed LCP equalled observed FCP in all five, which is what a
 * server-rendered paragraph should do — the LCP element is the About text in
 * `PublicFarmBody`, rendered by a server component with no Suspense boundary
 * around it.
 *
 * So the gate was stabilising a simulator, not a page. `aggregationMethod:
 * median` over five samples cannot fix a 2331ms spread, and a 1% overshoot
 * therefore arrives on whichever commit is unlucky.
 *
 * ## The decision this holds
 *
 * Owner ruling 2026-10-16, after the measurement corrected an earlier ruling
 * made on my own wrong framing: **measure instead of model.** With
 * `throttlingMethod: devtools` Lighthouse throttles the CPU and network for
 * real and reports what it saw, so the budget bounds an observation.
 *
 * A guard cannot check that the gate is accurate — it would have to run
 * Lighthouse. What it can hold is the DECISION, because the obvious future
 * edit is to restore `simulate` to make a slow job fast again, and the number
 * it reports would still look like a paint time.
 *
 * `numberOfRuns` dropped 5 -> 3 in the same change. That is not a weakening: a
 * measured value needs fewer samples than a modelled one, and the per-attempt
 * cap cannot grow to pay for slower runs because
 * `tests/guardrails/ci-retry-loop-timeout.test.ts` caps it at 300s.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../helpers/collect-files';

interface LighthouseRc {
    ci?: {
        collect?: {
            url?: string[];
            numberOfRuns?: number;
            settings?: { throttlingMethod?: string };
        };
    };
}

const rc = JSON.parse(
    readFileSync(join(REPO_ROOT, 'lighthouserc.json'), 'utf8'),
) as LighthouseRc;

const workflow = readFileSync(
    join(REPO_ROOT, '.github/workflows/lighthouse.yml'),
    'utf8',
);

describe('the Lighthouse gate measures rather than models (#1980)', () => {
    it('ranges over the real config — the denominator', () => {
        const urls = rc.ci?.collect?.url ?? [];
        console.log(
            `[lighthouse-gate] ${urls.length} URL(s), ${rc.ci?.collect?.numberOfRuns} run(s) each,` +
                ` throttlingMethod=${rc.ci?.collect?.settings?.throttlingMethod}`,
        );
        // Both URLs still measured. A config trimmed to one would make this
        // guard pass while halving what the gate covers.
        expect(urls.length).toBeGreaterThanOrEqual(2);
    });

    it('throttles for real, so the budget bounds an observation', () => {
        // Named in the failure rather than asserted bare, so a revert says
        // what to restore and why it was chosen.
        expect(`throttlingMethod: ${rc.ci?.collect?.settings?.throttlingMethod}`).toBe(
            'throttlingMethod: devtools',
        );
    });

    it('keeps enough samples to take a median of', () => {
        // Three is the floor: `scripts/ci/lighthouse-median.mjs` reports the
        // median, and a median of two is the mean of two.
        expect(rc.ci?.collect?.numberOfRuns).toBeGreaterThanOrEqual(3);
    });

    it('the timeout warning states no bound of its own', () => {
        // The drift this change also fixed. The branch said "timed out after
        // 600s" while the cap two lines above it said 250 — the message was
        // left behind when the cap was lowered, so a timeout misreported its
        // own limit.
        //
        // It cannot be interpolated either: ci-retry-loop-timeout.test.ts
        // matches /\btimeout\s+(?:-k\s+\d+\s+)?(\d+)\b/ and so REQUIRES a
        // literal after `timeout`, which is exactly what let the two numbers
        // drift apart. Printing elapsed time instead is drift-proof.
        const branch = workflow.slice(workflow.indexOf('"$status" -eq 124'));
        const echoLine = branch.split('\n').find((l) => l.includes('::warning::')) ?? '';
        expect(echoLine).not.toBe('');
        // No "<digits>s" in the message — that is the shape that went stale.
        expect(echoLine).not.toMatch(/\d+s\b/);
        // And it still says something useful about duration.
        expect(echoLine).toContain('SECONDS - started');
    });

    it('the cap is still a literal, which the retry guard requires', () => {
        // Asserted here only because THIS change is what would be tempted to
        // parameterise it: the fix above wanted a variable and could not have
        // one. The cap's VALUE and its relation to the job budget belong to
        // ci-retry-loop-timeout.test.ts and are not re-checked here.
        expect(workflow).toMatch(/timeout -k 10 \d+ npx/);
    });
});

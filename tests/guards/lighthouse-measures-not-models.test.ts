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
 *
 * ## What the switch bought, measured on run 38892602507
 *
 * The first `devtools` run, three samples per URL:
 *
 *   /f/lighthouse   LCP 1684 / 1684 / 1683 ms   SPREAD    1ms
 *   /login          LCP 6352 / 6266 / 6228 ms   SPREAD  123ms
 *
 * The simulator, on the same page:
 *
 *   /f/lighthouse   LCP 2765 .. 5096 ms         SPREAD 2331ms
 *
 * So the noise on `/f/*` fell from 2331ms to **1ms**. With `devtools` there is
 * no simulation layer: the report's `observedLargestContentfulPaint` equals the
 * asserted value, and for `/f/*` it also equals FCP — which is what a
 * server-rendered paragraph should do and what the simulator was obscuring.
 *
 * That is why the `/f/*` budget was **tightened to 2200ms, not raised**. The
 * old 3600ms was 2.1x the measured value and could not have caught a
 * regression short of doubling the page's paint time. 2200ms leaves 516ms of
 * headroom over a measurement whose within-run spread is 1ms; the margin is for
 * runner-to-runner variation, which a single job cannot measure.
 *
 * Collection took 181s of the 250s cap, so the cap did not need to move.
 *
 * ## The cross-run variance, measured on a SECOND job
 *
 * One job cannot measure runner-to-runner variation, so the margin above was
 * set without it. Run 38894573566, a different job on a different runner:
 *
 *   /f/lighthouse   1684ms -> 1678ms   delta  6ms
 *   /login          6266ms -> 6247ms   delta 19ms
 *
 * (collection 181s then 187s, both inside the cap.)
 *
 * So the total observed variation on `/f/*` is **6ms**, against the 516ms of
 * headroom 2200ms leaves. 1900ms would still carry 37x the observed spread —
 * and it is NOT set there, deliberately. Two jobs is not a distribution, and
 * fixing a bound from too few samples is the exact mistake this guard exists
 * to prevent: 3600ms looked defensible for the same reason. Whoever has a
 * dozen main-branch runs can tighten on evidence, and the ratchet below makes
 * that free — lowering the number needs no change here.
 *
 * `/login` stays at 7000ms against a measured 6266ms. It is not noise-bound
 * (123ms spread, 734ms headroom) — but a 6.3s LCP with FCP at 2.1s on the
 * sign-in page is a real finding now that it is MEASURED rather than modelled,
 * and it is filed separately rather than answered by moving its budget.
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
        assert?: {
            assertMatrix?: Array<{
                matchingUrlPattern?: string;
                aggregationMethod?: string;
                assertions?: Record<string, unknown[]>;
            }>;
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

    /*
     * My flat version of the doc-key check stood here, and is deleted rather
     * than merged. #2180 landed `every assertions KEY is an audit id` below
     * while this branch was open: a recursive scan over the whole config is
     * strictly broader than one pass over `assertMatrix[].assertions`, and it
     * already asserts its own denominator, so nothing of mine was left to
     * keep. Two tests for one property is how one of them rots unnoticed.
     */
    it('throttles for real, so the budget bounds an observation', () => {
        // Named in the failure rather than asserted bare, so a revert says
        // what to restore and why it was chosen.
        expect(`throttlingMethod: ${rc.ci?.collect?.settings?.throttlingMethod}`).toBe(
            'throttlingMethod: devtools',
        );
    });

    it('keeps enough samples to take a median of', () => {
        // FIVE as of #2179, raised from three, and paid for by splitting the
        // workflow to one URL per job.
        //
        // Three was defended as "a median of two is the mean of two" — true,
        // and not the binding constraint. The `/f/` entry's 3800 ms bound came
        // from a FIVE-run median and was enforced on a three-run one; that
        // entry already records two 3-run medians of the SAME commit landing
        // 296 ms apart. Measured 2026-10-22: three of eight runs failed on an
        // unchanged page across main and two unrelated branches (medians
        // 4052 / 4086 / 4206, single-sample max 4220).
        //
        // Five runs of BOTH urls in one job does not fit, and that was
        // measured rather than reasoned: 3 x 2 is 197s against a 250s cap, so
        // ~33s per run puts 5 x 2 at ~328s, and it timed out 3/3 (250s, 510s,
        // 770s elapsed) producing no median. The cap could not absorb it
        // (`ci-retry-loop-timeout` holds it at 300) and said so itself —
        // "fewer runs or one URL per job, not a bigger cap". Hence the matrix.
        //
        // A floor rather than equality, so a page needing more samples can
        // raise it without editing this line.
        expect(rc.ci?.collect?.numberOfRuns).toBeGreaterThanOrEqual(5);
    });

    it('still declares BOTH urls, because the matrix narrows them (#2179)', () => {
        // The split moved COLLECTION to one URL per job via `--collect.url`,
        // which replaces this list rather than appending to it (verified
        // 2026-10-22). So the config stopped being what runs and became the
        // record of what is measured — and a record is exactly the thing that
        // rots silently. If a page is dropped from the matrix, this still
        // says two are covered, so assert the pair that must stay declared.
        const urls = rc.ci?.collect?.url ?? [];
        expect(urls.some((u) => /\/login$/.test(u))).toBe(true);
        expect(urls.some((u) => /\/f\//.test(u))).toBe(true);
        // And every declared URL must have a matrix leg collecting it, or the
        // budget below it is asserted against nothing.
        for (const u of urls) {
            expect(workflow).toContain(u);
        }
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

    it('the /f/* budget stays near its measured baseline — tighten freely, loosen loudly', () => {
        // A RATCHET, not a pin. Lowering this number needs no change here;
        // RAISING it fails — that is the direction which silently disarms a
        // gate, and the direction the first instinct on #1980 pointed.
        //
        // Derived: measured median 1684ms, within-run spread 1ms. The ceiling
        // admits runner-to-runner variation an order of magnitude larger than
        // anything observed, while still failing on a real regression.
        //
        // 2600 -> 3800, and 1684 -> 3494, by P6.3 (#2062). This is the LOUD
        // half of "tighten freely, loosen loudly": the budget could not be
        // raised without editing this test, which is the mechanism working.
        //
        // What changed is the page, not the tolerance. It had no images when
        // 1684ms was measured; it now carries a logo and up to six
        // photographs, and three CI runs on #2060 measured the cost at
        // 15438ms with 1600px originals, 4056ms with 440px thumbnails, and
        // 3358ms once the gallery moved below the about text.
        //
        // What remains is structural. Images cannot begin loading before first
        // paint — Load Delay was 1639ms — and FCP on this page is 1699ms, so
        // any VISIBLE image lands at roughly 1700ms plus its own load. The LCP
        // element is a photograph in every run, because on a short page at
        // grid-cols-2 a cell is the largest thing on it. A 2200ms ceiling left
        // no room for an image at all.
        //
        // The FLOOR moves for the reason the floor exists: the page now
        // measures 3333/3358/3495, so a budget at or below 3494 could never
        // pass, and this file already argues that an unpassable gate is worse
        // than a loose one because it gets switched off. The ceiling is the
        // live budget exactly, so the next loosening also has to come here.
        const matrix = rc.ci?.assert?.assertMatrix ?? [];
        const publicEntry = matrix.find((m) => m.matchingUrlPattern?.includes('/f/'));
        expect(publicEntry).toBeDefined();
        const lcp = publicEntry?.assertions?.['largest-contentful-paint'];
        const max = (lcp?.[1] as { maxNumericValue?: number } | undefined)?.maxNumericValue;
        // The run count comes from the CONFIG, not from a literal. It read
        // "(median of 3)" until #2179 raised the config to 5, and a printout
        // that mirrors a setting by hand goes stale the moment the setting
        // moves — silently, because nothing asserts on a log line.
        //
        // 3358 ms is kept as a literal deliberately: it is a HISTORICAL
        // measurement (2026-10-20, the three runs that set this bound), not a
        // mirror of anything live, and labelling it as such is what stops the
        // next reader taking it for the current figure. See #2179 for what the
        // page measured two days later.
        console.log(
            `[lighthouse-gate] /f/* LCP budget ${max}ms; baseline that set it 3358ms` +
                ` (3-run median, 2026-10-20); gate now takes a median of` +
                ` ${rc.ci?.collect?.numberOfRuns}`,
        );
        expect(typeof max).toBe('number');
        expect(max!).toBeLessThanOrEqual(3800);
        // And a floor, so a flake is never "fixed" by setting the budget below
        // what the page actually does — a gate that can never pass is worse
        // than one that is too loose, because it gets switched off entirely.
        expect(max!).toBeGreaterThan(3494);
    });

    it('/login gates what a person WAITS FOR, not when a promo bar appears (#2002)', () => {
        // Its LCP element is the PWA install banner — `InstallPrompt.tsx`, a
        // mobile-only fixed overlay rendered after hydration. Render Delay was
        // 6225ms of a 6266ms LCP while the sign-in FORM painted at FCP 2080ms.
        // So an LCP budget there gated when a promotional bar appears, and
        // would move whenever the install-prompt logic changed.
        //
        // Owner ruling 2026-10-16: gate FCP and TBT, drop LCP. Held here
        // because re-adding an LCP budget to this page is the obvious future
        // edit — the number looks like a paint time and the page looks slow.
        const login = (rc.ci?.assert?.assertMatrix ?? []).find((m) =>
            m.matchingUrlPattern?.includes('/login'),
        );
        expect(login).toBeDefined();
        const a = login?.assertions ?? {};
        expect(Object.keys(a).includes('largest-contentful-paint')).toBe(false);

        // And the two that replaced it must be GATES, not warnings. They were
        // both `warn` before, which is why "gate FCP and TBT" needed more than
        // tightening a number: a warn budget fails nothing.
        for (const metric of ['first-contentful-paint', 'total-blocking-time'] as const) {
            const level = (a[metric] as unknown[] | undefined)?.[0];
            expect(`${metric}: ${String(level)}`).toBe(`${metric}: error`);
        }
        console.log(
            `[lighthouse-gate] /login gates ${Object.entries(a)
                .filter(([, v]) => (v as unknown[])[0] === 'error')
                .map(([k]) => k)
                .join(', ')}`,
        );
    });

    it('every assertions KEY is an audit id, so a doc note cannot become an audit', () => {
        /**
         * #2178. This file documents itself with `"//"` keys, which is fine at
         * the top level and on a matrix ENTRY — lhci ignores both. Inside an
         * `assertions` object it is not: lhci reads every key there as an audit
         * name, so a 2406-character explanatory note became an audit called
         * `//` and failed `auditRan` on every single run.
         *
         * It was a GUARANTEED failure, not a flake — an audit that does not
         * exist can never have run — and it went unnoticed because the LCP
         * assertion was failing alongside it and masked which was which.
         *
         * Nothing checked this, which is why it slipped through. The rule is
         * narrow on purpose: an audit id is lower-case letters, digits and
         * dashes, optionally prefixed `categories:`. That admits every real
         * audit and rejects prose, a comment marker, or a stray key.
         */
        const AUDIT_ID = /^(categories:)?[a-z0-9][a-z0-9-]*$/;
        const offenders: string[] = [];
        let checked = 0;

        const scan = (node: unknown, path: string, inAssertions: boolean) => {
            if (Array.isArray(node)) {
                node.forEach((v, i) => scan(v, `${path}[${i}]`, inAssertions));
                return;
            }
            if (node === null || typeof node !== 'object') return;
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                if (inAssertions) {
                    checked += 1;
                    if (!AUDIT_ID.test(key)) offenders.push(`${path}.${key}`);
                    continue;
                }
                scan(value, `${path}.${key}`, key === 'assertions');
            }
        };
        scan(rc, '$', false);

        // The denominator, because a scan that reached no assertions block
        // would report zero offenders and look exactly like a clean config.
        expect(checked).toBeGreaterThanOrEqual(8);
        expect(offenders).toEqual([]);
    });

    it('the cap is still a literal, which the retry guard requires', () => {
        // Asserted here only because THIS change is what would be tempted to
        // parameterise it: the fix above wanted a variable and could not have
        // one. The cap's VALUE and its relation to the job budget belong to
        // ci-retry-loop-timeout.test.ts and are not re-checked here.
        expect(workflow).toMatch(/timeout -k 10 \d+ npx/);
    });
});

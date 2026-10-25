/**
 * The #2009 option-3 probe's classifier.
 *
 * The probe itself needs a network and a deployed site, so what CI can check
 * is the part that decides what a set of statuses MEANS — and that is the part
 * worth checking, because the whole design turns on one distinction:
 *
 *   a dark feature and an outage produce the SAME 404 on a gated surface.
 *
 * `assertFeatureEnabled` answers 404 rather than 403 by deliberate design
 * (anti-enumeration), which is precisely why #2009's instance 3 went unnoticed
 * for months. A probe that collapsed those two worlds would send someone
 * hunting a missing FeatureFlag row in the middle of an outage.
 */
import {
    classify,
    deriveFarmPage,
    CONTROL,
    GATED,
    DIRECTORY_PATH,
} from '../../scripts/public-surface-probe';

const ok = (path: string) => ({ path, status: 200 });
const gone = (path: string) => ({ path, status: 404 });

/**
 * The third argument is REQUIRED, which is why these exist rather than a
 * default. Every case below has to say whether the farm page was covered —
 * that is the property #2328 added, and a default would have let these
 * assertions keep passing while saying nothing.
 */
const uncovered = { probed: false as const, why: 'no published farm profile exists' };
const covered = (path: string) => ({ probed: true as const, path });

describe('the probe tells a dark feature from an outage', () => {
    it('OK when the control and every gated surface answer', () => {
        expect(classify(200, [ok('/sitemap.xml'), ok(DIRECTORY_PATH)], uncovered).state).toBe('OK');
    });

    it('DARK when a gated surface 404s and the control is FINE', () => {
        // Instance 3's exact signature: the row is missing, the surface is off
        // for everybody, and the site is otherwise healthy.
        const v = classify(200, [ok('/sitemap.xml'), gone(DIRECTORY_PATH)], uncovered);
        expect(v.state).toBe('DARK');
        expect(v.detail).toContain('/api/public/farms');
        // The detail has to say WHY a 404 means this, or the next reader
        // re-derives it under pressure.
        expect(v.detail).toContain('FeatureFlag');
    });

    it('OUTAGE — not DARK — when the control itself is down', () => {
        // The discriminator. Identical gated results to the DARK case above;
        // only the control differs, and the verdict must flip.
        const darkCase = classify(200, [gone(DIRECTORY_PATH)], uncovered);
        const outageCase = classify(503, [gone(DIRECTORY_PATH)], uncovered);
        expect(darkCase.state).toBe('DARK');
        expect(outageCase.state).toBe('OUTAGE');
    });

    it('OUTAGE when nothing answered at all', () => {
        expect(classify(null, [{ path: '/x', status: null }], uncovered).state).toBe('OUTAGE');
    });

    it('BROKEN when the control answers something uninterpretable', () => {
        // A redirect on robots.txt is neither reachable nor an outage. Saying
        // BROKEN is honest; guessing either way would be a verdict the probe
        // has not earned.
        expect(classify(301, [ok('/sitemap.xml')], uncovered).state).toBe('BROKEN');
    });

    it('BROKEN when a gated surface 5xxs rather than 404s', () => {
        // A 500 is not a missing flag row — it is a failing route, and calling
        // it DARK would point the fix at the wrong place.
        const v = classify(200, [{ path: DIRECTORY_PATH, status: 500 }], uncovered);
        expect(v.state).toBe('BROKEN');
        expect(v.detail).toContain('/api/public/farms');
    });
});

describe('the surface list is a real list with stated reasons', () => {
    it('has an ungated control and at least one gated surface', () => {
        expect(CONTROL.path).toBeTruthy();
        expect(GATED.length).toBeGreaterThan(0);
    });

    it('every entry says WHY it belongs — an unexplained probe target rots', () => {
        for (const s of [CONTROL, ...GATED]) {
            expect(s.why.length).toBeGreaterThan(30);
        }
    });

    it('the control is NOT one of the gated surfaces', () => {
        // If the control were itself gated, a missing row would take down the
        // control and every verdict with it — the probe would report OUTAGE
        // for exactly the condition it exists to detect.
        expect(GATED.map((s) => s.path)).not.toContain(CONTROL.path);
    });
});

describe('the farm page is DERIVED, and its absence is stated (#2328)', () => {
    it('reads the first usable handle out of the directory body', () => {
        const d = deriveFarmPage([{ handle: 'pobeda' }, { handle: 'dobrudzha' }]);
        expect(d).toEqual({ probed: true, path: '/f/pobeda' });
    });

    it('an EMPTY directory is a stated non-coverage, not a silent pass', () => {
        // Production's state when #2326 shipped: 0 PublicFarmProfile. The point
        // of the issue is that this must be VISIBLE in the verdict.
        const d = deriveFarmPage([]);
        expect(d.probed).toBe(false);
        expect((d as { why: string }).why).toContain('no published farm profile');
    });

    it('a body that is not an array says the derivation is stale', () => {
        // The endpoint returns a BARE array today. If that becomes an envelope,
        // this derivation is wrong and must say so rather than find no handle
        // and report "nothing published".
        const d = deriveFarmPage({ items: [{ handle: 'pobeda' }] });
        expect(d.probed).toBe(false);
        expect((d as { why: string }).why).toContain('did not return an array');
    });

    it('refuses a handle that could not sit in a path unescaped', () => {
        // Silently encoding it would make the probe assert about a URL the
        // product never serves.
        const d = deriveFarmPage([{ handle: '../admin' }, { handle: 'has space' }]);
        expect(d.probed).toBe(false);
        expect((d as { why: string }).why).toContain('usable handle');
    });

    it('OK NAMES the surface it did not cover', () => {
        // The whole defect: a green reading over a population that excludes the
        // interesting case. Green is allowed; silent is not.
        const v = classify(200, [ok('/sitemap.xml'), ok(DIRECTORY_PATH)], uncovered);
        expect(v.state).toBe('OK');
        expect(v.detail).toContain('/f/{handle}');
        expect(v.detail).toContain('no published farm profile');
    });

    it('OK names the farm page when it WAS covered', () => {
        const v = classify(
            200,
            [ok('/sitemap.xml'), ok(DIRECTORY_PATH), ok('/f/pobeda')],
            covered('/f/pobeda'),
        );
        expect(v.state).toBe('OK');
        expect(v.detail).toContain('/f/pobeda');
        expect(v.detail).not.toContain('NOT covering');
    });

    it('a 404 on the DERIVED page is DARK like any other surface', () => {
        // Why it is pushed into the same list rather than handled separately:
        // the farm page going dark is the case #2009 was mostly about.
        const v = classify(
            200,
            [ok('/sitemap.xml'), ok(DIRECTORY_PATH), gone('/f/pobeda')],
            covered('/f/pobeda'),
        );
        expect(v.state).toBe('DARK');
        expect(v.detail).toContain('/f/pobeda');
    });
});

describe('the derivation is actually wired to a probed surface', () => {
    it('DIRECTORY_PATH is one of the GATED entries', () => {
        // `main()` keeps the body of whichever GATED surface equals
        // DIRECTORY_PATH. If that constant drifted from the entry — a rename on
        // one and not the other — no body would ever be captured, and the probe
        // would report a PERMANENT "did not answer 200, so no handle could be
        // read" while the directory was answering 200 all along.
        //
        // That is the #2328 failure mode wearing a different hat: a stated
        // non-coverage that is stated for the wrong reason, which reads as
        // "nothing is published" forever. One assertion closes it; `main()`
        // itself needs a network and a deployed site, so this is the part CI
        // can hold.
        expect(GATED.map((g) => g.path)).toContain(DIRECTORY_PATH);
    });
});

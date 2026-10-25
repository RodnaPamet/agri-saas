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
import { classify, CONTROL, GATED } from '../../scripts/public-surface-probe';

const ok = (path: string) => ({ path, status: 200 });
const gone = (path: string) => ({ path, status: 404 });

describe('the probe tells a dark feature from an outage', () => {
    it('OK when the control and every gated surface answer', () => {
        expect(classify(200, [ok('/sitemap.xml'), ok('/api/public/farms')]).state).toBe('OK');
    });

    it('DARK when a gated surface 404s and the control is FINE', () => {
        // Instance 3's exact signature: the row is missing, the surface is off
        // for everybody, and the site is otherwise healthy.
        const v = classify(200, [ok('/sitemap.xml'), gone('/api/public/farms')]);
        expect(v.state).toBe('DARK');
        expect(v.detail).toContain('/api/public/farms');
        // The detail has to say WHY a 404 means this, or the next reader
        // re-derives it under pressure.
        expect(v.detail).toContain('FeatureFlag');
    });

    it('OUTAGE — not DARK — when the control itself is down', () => {
        // The discriminator. Identical gated results to the DARK case above;
        // only the control differs, and the verdict must flip.
        const darkCase = classify(200, [gone('/api/public/farms')]);
        const outageCase = classify(503, [gone('/api/public/farms')]);
        expect(darkCase.state).toBe('DARK');
        expect(outageCase.state).toBe('OUTAGE');
    });

    it('OUTAGE when nothing answered at all', () => {
        expect(classify(null, [{ path: '/x', status: null }]).state).toBe('OUTAGE');
    });

    it('BROKEN when the control answers something uninterpretable', () => {
        // A redirect on robots.txt is neither reachable nor an outage. Saying
        // BROKEN is honest; guessing either way would be a verdict the probe
        // has not earned.
        expect(classify(301, [ok('/sitemap.xml')]).state).toBe('BROKEN');
    });

    it('BROKEN when a gated surface 5xxs rather than 404s', () => {
        // A 500 is not a missing flag row — it is a failing route, and calling
        // it DARK would point the fix at the wrong place.
        const v = classify(200, [{ path: '/api/public/farms', status: 500 }]);
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

/**
 * Guided first-run flow (feat/delight-onboarding) — the pure progress
 * derivation + the dismiss-key shape. The card itself is a thin render
 * over these; locking the data contract here keeps the ring honest
 * (it can only show "done" when the underlying signal is true) and the
 * dedupe key stable (it rides in localStorage).
 */
import { readCatalogue } from '../helpers/catalogue';

import {
    FIRST_RUN_STEPS,
    firstRunProgress,
    firstRunDismissKey,
    type FirstRunSignals,
} from '@/lib/onboarding-steps';

describe('FIRST_RUN_STEPS', () => {
    it('is the two-step "map a field → log a job" flow', () => {
        expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual([
            'first-field-mapped',
            'first-job-logged',
        ]);
        // Every step carries a CTA, a destination, and a reason — the card
        // renders all three, so none may be empty.
        for (const step of FIRST_RUN_STEPS) {
            expect(step.labelKey.length).toBeGreaterThan(0);
            expect(step.hintKey.length).toBeGreaterThan(0);
            expect(step.ctaKey.length).toBeGreaterThan(0);
            expect(step.href.startsWith('/')).toBe(true);
        }
    });

    it('every key RESOLVES in both catalogues — #2858', () => {
        /*
         * The assertion above only says the keys are non-empty, and that was
         * true of the hard-coded ENGLISH prose it replaced. What makes the
         * change an improvement is that each key reaches a real value in BOTH
         * locales: a key with no entry renders as the key itself, which is
         * worse on screen than the English was.
         *
         * Read off the catalogues rather than mocked, because the failure this
         * guards is a MISSING ENTRY and a mock cannot be missing one.
         *
         * Through `readCatalogue` and not `readFileSync`: #1813 moved the
         * catalogue's path behind one function so `messages/` can be split
         * into bundles without touching any caller, and
         * `one-catalogue-reader` holds the direct-reader count at zero. My
         * first version read the files directly and that guard caught it in
         * CI — correctly, and it is why the path appears nowhere here.
         */
        const en = readCatalogue('en') as unknown as {
            dashboard: { firstRun: Record<string, string> };
        };
        const bg = readCatalogue('bg') as unknown as {
            dashboard: { firstRun: Record<string, string> };
        };

        const keys = FIRST_RUN_STEPS.flatMap((s) => [s.labelKey, s.hintKey, s.ctaKey]);
        // The denominator, so a registry that lost its steps cannot pass here
        // by having nothing to check.
        expect(keys).toHaveLength(6);

        for (const k of keys) {
            expect(typeof en.dashboard.firstRun[k]).toBe('string');
            expect(typeof bg.dashboard.firstRun[k]).toBe('string');
            expect((en.dashboard.firstRun[k] ?? '').length).toBeGreaterThan(0);
            expect((bg.dashboard.firstRun[k] ?? '').length).toBeGreaterThan(0);
            // And the Bulgarian is a TRANSLATION, not the English pasted in —
            // the thing `i18n-diff`'s untranslated axis exists for, asserted
            // here too so these six cannot regress to a copy-paste.
            expect(bg.dashboard.firstRun[k]).not.toBe(en.dashboard.firstRun[k]);
        }
    });
});

describe('firstRunProgress', () => {
    const run = (s: FirstRunSignals) => firstRunProgress(s);

    it('nothing done → 0/2, not complete', () => {
        const p = run({ fieldMapped: false, jobLogged: false });
        expect(p.completedCount).toBe(0);
        expect(p.total).toBe(2);
        expect(p.allComplete).toBe(false);
        expect(p.steps.every((s) => !s.done)).toBe(true);
    });

    it('field mapped only → 1/2, the field step is the done one', () => {
        const p = run({ fieldMapped: true, jobLogged: false });
        expect(p.completedCount).toBe(1);
        expect(p.allComplete).toBe(false);
        expect(p.steps.find((s) => s.step.id === 'first-field-mapped')?.done).toBe(true);
        expect(p.steps.find((s) => s.step.id === 'first-job-logged')?.done).toBe(false);
    });

    it('both signals true → 2/2, complete (card self-hides)', () => {
        const p = run({ fieldMapped: true, jobLogged: true });
        expect(p.completedCount).toBe(2);
        expect(p.allComplete).toBe(true);
    });
});

describe('firstRunDismissKey', () => {
    it('namespaces under the inflect onboarding prefix, scoped per tenant', () => {
        expect(firstRunDismissKey('tenant_abc')).toBe(
            'inflect:onboarding-firstrun:dismissed:tenant_abc',
        );
        // Distinct tenants get distinct keys.
        expect(firstRunDismissKey('t1')).not.toBe(firstRunDismissKey('t2'));
    });
});

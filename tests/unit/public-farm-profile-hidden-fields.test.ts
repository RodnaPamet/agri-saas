/**
 * A withheld field does not reach the public projection — P6.6 (#1815).
 *
 * `projectionPayload` is the ONE place that decides what crosses from
 * `FarmBrand` to `PublicFarmProfile`, so this is where hiding has to bite. If
 * it bit in the usecase instead, every other caller of the projection would
 * be a way around it.
 *
 * ## What "hidden" has to look like from outside
 *
 * Indistinguishable from unset. The flags are `privateField` in the allowlist
 * precisely so the page cannot reveal that something is being withheld, and
 * that only holds if a hidden tagline projects as `null` rather than as, say,
 * an empty string or a placeholder. Asserted per field, because a shared
 * helper that got one of the four wrong would still look right in a summary.
 */
import { projectionPayload } from '@/app-layer/projections/public-farm-profile.allowlist';

const FULL = {
    handle: 'pobeda',
    displayName: 'Стопанство Победа',
    tagline: 'Зърно от Добруджа',
    about: 'Семейно стопанство от три поколения.',
    oblast: 'Добрич',
    crops: ['пшеница', 'слънчоглед'],
    indexable: false,
    hideTagline: false,
    hideAbout: false,
    hideOblast: false,
    hideCrops: false,
};

describe('per-field visibility in the public projection', () => {
    it('projects everything when nothing is hidden — the control', () => {
        const out = projectionPayload(FULL);
        expect(out.tagline).toBe('Зърно от Добруджа');
        expect(out.about).toBe('Семейно стопанство от три поколения.');
        expect(out.oblast).toBe('Добрич');
        expect(out.crops).toEqual(['пшеница', 'слънчоглед']);
    });

    it.each([
        ['hideTagline', 'tagline', null],
        ['hideAbout', 'about', null],
        ['hideOblast', 'oblast', null],
        ['hideCrops', 'crops', []],
    ] as const)('%s withholds %s and nothing else', (flag, field, absent) => {
        const out = projectionPayload({ ...FULL, [flag]: true });

        // The field is ABSENT, in the shape an unset field has: `null` for the
        // three nullable ones, `[]` for the list — which is the cleared state
        // a list already has, since `crops` has no null form.
        expect(out[field]).toEqual(absent);

        // And ONLY that field. One shared mistake — a helper reading the wrong
        // flag — would show up here rather than in a pass/fail summary.
        const others = (['tagline', 'about', 'oblast', 'crops'] as const).filter(
            (f) => f !== field,
        );
        for (const other of others) {
            expect(out[other]).toEqual(FULL[other]);
        }
    });

    it('hides all four at once, leaving a page with only a name', () => {
        const out = projectionPayload({
            ...FULL,
            hideTagline: true,
            hideAbout: true,
            hideOblast: true,
            hideCrops: true,
        });
        expect(out).toMatchObject({
            handle: 'pobeda',
            displayName: 'Стопанство Победа',
            tagline: null,
            about: null,
            oblast: null,
            crops: [],
        });
        // handle and displayName survive, because they have no toggle: both are
        // publication preconditions and the projection's columns are NOT NULL.
        expect(out.handle).toBeTruthy();
        expect(out.displayName).toBeTruthy();
    });

    it('never leaks the flags themselves into the payload', () => {
        // They are `privateField` in the allowlist. A flag on the wire would
        // tell a visitor that a field exists and is being withheld — the one
        // thing hiding it is meant to avoid.
        const out = projectionPayload({ ...FULL, hideAbout: true });
        for (const key of ['hideTagline', 'hideAbout', 'hideOblast', 'hideCrops']) {
            expect(Object.keys(out)).not.toContain(key);
        }
    });
});

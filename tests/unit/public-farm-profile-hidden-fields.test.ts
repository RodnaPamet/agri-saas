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
    // P6.3 (#1812). Present on the fixture because `projectionPayload` now
    // requires them, and populated rather than empty so the cases below show
    // that media crosses REGARDLESS of the eye toggles — these fields are
    // `NOT_HIDEABLE`, so no flag can withhold them and a fixture with an empty
    // gallery could not tell a carried value from a dropped one.
    logoMediaHash: 'c'.repeat(64),
    photoMediaHashes: ['d'.repeat(64), 'e'.repeat(64)],
};

/**
 * No thumbnails — #2062.
 *
 * These cases are about VISIBILITY, not about media derivatives, so they use
 * the empty map and exercise the fallback: an original with no thumbnail
 * crosses as itself. The thumbnail mapping has its own cases below.
 */
const NO_THUMBS = { thumbFor: new Map<string, string>() };

describe('per-field visibility in the public projection', () => {
    it('media crosses even with every toggle ON — it is NOT_HIDEABLE', () => {
        // The partition's claim, executed. `logoMediaHash` and
        // `photoMediaHashes` are in NOT_HIDEABLE, so there is no flag that
        // withholds them; a farm withdraws a photograph by removing its hash.
        // Hiding all four text fields must leave the gallery untouched.
        const out = projectionPayload({
            ...FULL,
            hideTagline: true,
            hideAbout: true,
            hideOblast: true,
            hideCrops: true,
        }, NO_THUMBS);
        expect(out.logoMediaHash).toBe('c'.repeat(64));
        expect(out.photoMediaHashes).toEqual(['d'.repeat(64), 'e'.repeat(64)]);
        // The control: the text fields DID get withheld, so this fixture can
        // tell "unaffected" from "nothing happened".
        expect(out.tagline).toBeNull();
        expect(out.crops).toEqual([]);
    });

    describe('thumbnails cross instead of originals — #2062', () => {
        it('maps each original to its thumbnail', () => {
            // What the projection publishes is what the public page fetches,
            // and the page renders a ~213 px cell. Publishing the 1600 px
            // original there cost LCP 15438 ms against a 2200 ms budget.
            const thumbFor = new Map([
                ['d'.repeat(64), '1'.repeat(64)],
                ['e'.repeat(64), '2'.repeat(64)],
            ]);
            const out = projectionPayload(FULL, { thumbFor });
            expect(out.photoMediaHashes).toEqual(['1'.repeat(64), '2'.repeat(64)]);
        });

        it('FALLS BACK to the original when no thumbnail exists', () => {
            // Photographs uploaded before thumbnails existed keep rendering —
            // larger than they should be, which is a performance problem
            // rather than a broken page. A projection that dropped them would
            // make an old photo vanish from a published profile.
            const thumbFor = new Map([['d'.repeat(64), '1'.repeat(64)]]);
            const out = projectionPayload(FULL, { thumbFor });
            expect(out.photoMediaHashes).toEqual(['1'.repeat(64), 'e'.repeat(64)]);
        });

        it('keeps the ORDER the owner arranged, not the map order', () => {
            // The array is the gallery. A map iteration order leaking into the
            // projection would shuffle somebody's page between refreshes.
            const thumbFor = new Map([
                ['e'.repeat(64), '2'.repeat(64)],
                ['d'.repeat(64), '1'.repeat(64)],
            ]);
            const out = projectionPayload(FULL, { thumbFor });
            expect(out.photoMediaHashes).toEqual(['1'.repeat(64), '2'.repeat(64)]);
        });

        it('leaves the LOGO unmapped — it is already display-sized', () => {
            // Measured: the seeded 400 px logo is 8 KB against 432 KB for a
            // 1600 px photograph, so a derivative would add an artefact and a
            // hash to save nothing. A map entry for it must not be honoured.
            const thumbFor = new Map([['c'.repeat(64), '9'.repeat(64)]]);
            const out = projectionPayload(FULL, { thumbFor });
            expect(out.logoMediaHash).toBe('c'.repeat(64));
        });
    });

    it('copies the gallery rather than aliasing it', () => {
        // `[...brand.photoMediaHashes]`. Returning the caller's array would
        // let a later mutation of the brand row change what was projected.
        const out = projectionPayload(FULL, NO_THUMBS);
        expect(out.photoMediaHashes).not.toBe(FULL.photoMediaHashes);
        expect(out.photoMediaHashes).toEqual(FULL.photoMediaHashes);
    });

    it('projects everything when nothing is hidden — the control', () => {
        const out = projectionPayload(FULL, NO_THUMBS);
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
        const out = projectionPayload({ ...FULL, [flag]: true }, NO_THUMBS);

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
        }, NO_THUMBS);
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
        const out = projectionPayload({ ...FULL, hideAbout: true }, NO_THUMBS);
        for (const key of ['hideTagline', 'hideAbout', 'hideOblast', 'hideCrops']) {
            expect(Object.keys(out)).not.toContain(key);
        }
    });
});

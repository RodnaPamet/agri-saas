/**
 * The Lighthouse seeding generates what the PRODUCT generates — #2062.
 *
 * ## Why this guard exists
 *
 * `scripts/seed-lighthouse-media.mjs` gives `/f/lighthouse` its images so the
 * LCP and CLS budgets measure a page that has them. It cannot import
 * `FARM_MEDIA_THUMB_DIMENSION`: the script is plain ESM run by `node`, and
 * that constant lives in TypeScript inside the app's path-aliased graph. So
 * the number is copied.
 *
 * A copied number that drifts is worse here than almost anywhere else. If the
 * product moved to 640px and the seeding stayed at 440px, the budget would
 * keep passing against images a third of the weight of the real ones — green,
 * and reporting on a page nobody is served. That is the exact failure the
 * seeding was added to prevent (#2009), reintroduced one constant lower down.
 *
 * ## Why it reads the script's text rather than running it
 *
 * Running it needs a database, a storage root and a seeded profile row. The
 * claim here is narrower than behaviour: the two literals agree. Reading them
 * is the cheapest thing that can fail for the right reason.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FARM_MEDIA_THUMB_DIMENSION } from '@/app-layer/usecases/farm-brand-media';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SEED = path.join(REPO_ROOT, 'scripts/seed-lighthouse-media.mjs');

describe('the Lighthouse seeding matches the image pipeline (#2062)', () => {
    const source = readFileSync(SEED, 'utf8');

    it('ranges over a real file — the denominator', () => {
        // A moved or renamed script would make every assertion below read an
        // empty string and pass.
        expect(source.length).toBeGreaterThan(2000);
        expect(source).toContain('seed-lighthouse-media');
    });

    it('generates thumbnails at the dimension the product uses', () => {
        const m = source.match(/const THUMB_DIMENSION = (\d+);/);
        // Asserted as a pair, so the failure prints both numbers rather than
        // `false` — the useful output here is which one moved.
        expect({
            seed: m ? Number(m[1]) : null,
            pipeline: FARM_MEDIA_THUMB_DIMENSION,
        }).toEqual({
            seed: FARM_MEDIA_THUMB_DIMENSION,
            pipeline: FARM_MEDIA_THUMB_DIMENSION,
        });
    });

    it('publishes the THUMBNAIL hashes, not the originals', () => {
        // The decision `projectFarmBrand` makes. This script writes the
        // projection directly — going through that function would need a
        // tenant, a membership and an admin context — so it reproduces the
        // decision, and a reproduction can diverge.
        //
        // Pinned on the expression that selects what crosses. If somebody
        // changes it back to `p.original.sha256` the page serves 2601 KB
        // again, the budget fails, and without this the failure looks like a
        // performance regression in the product rather than a broken fixture.
        expect(source).toContain('photos.map((p) => p.thumb.sha256)');
        expect(source).not.toContain('photos.map((p) => p.original.sha256)');
    });

    it('sets the pairing the projection writer reads', () => {
        // Without `derivedFromSha256`, `projectFarmBrand` finds no thumbnail
        // and falls back to the original — the correct fallback, and the wrong
        // thing to measure.
        expect(source).toContain('derivedFromSha256');
    });

    it('seeds the CEILING, so the budget bounds the worst real case', () => {
        // `FARM_BRAND_MAX_PHOTOS` is 6. A seeding of two would pass while the
        // cap allowed something that fails.
        const m = source.match(/const PHOTO_COUNT = (\d+);/);
        expect(m && Number(m[1])).toBe(6);
    });
});

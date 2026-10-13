/**
 * A route justified as anonymous must actually be reachable anonymously (#1745).
 *
 * ## The seam this closes
 *
 * `public-routes-self-authenticate.test.ts` asks whether a route that needs no
 * credential is DELIBERATE — every such route carries a written justification
 * in its `EXEMPT` map. That is a claim about the HANDLER.
 *
 * `isPublicPath` in `src/lib/auth/guard.ts` decides whether the EDGE lets an
 * anonymous request through at all. That is a different list, maintained by
 * hand, and **nothing compared the two.**
 *
 * So `POST /api/public/notices` — the DSA Art 16 notice form — carried this,
 * verbatim, in the exemption map:
 *
 * > anonymous by design, and by LEGAL DUTY. DSA Art 16 requires a mechanism any
 * > person or entity can use to notify illegal content, so requiring an account
 * > would be requiring an account to exercise a right.
 *
 * …and returned **401 to everyone**, because it was never added to the Edge
 * list. Measured on production, three times. Nobody outside the product could
 * notify illegal content from the day P5.2 shipped.
 *
 * One half of the repo stated the route was anonymous by legal duty; the other
 * half silently refused it. Both halves were individually correct.
 *
 * ## Two populations, and why the first is the stronger one
 *
 * §1 derives from the FILESYSTEM: every route under `src/app/api/public/`. The
 * `public` segment is a naming convention that means exactly one thing, so a
 * new route placed there is covered the moment it exists — nobody has to
 * remember to list it. This is the check that would have caught #1745.
 *
 * §2 reads the sibling guard's `EXEMPT` keys, which covers the routes that are
 * anonymous WITHOUT living under `/api/public/` — the signed webhooks, the
 * health probes. That map is local to a test rather than exported, so this
 * parses it; the parse is floored so an empty extraction fails loudly instead
 * of passing over nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { collectSourceFiles } from '../helpers/collect-files';
import { isPublicPath } from '@/lib/auth/guard';

const ROOT = join(__dirname, '..', '..');
const SIBLING = 'tests/guards/public-routes-self-authenticate.test.ts';

/** Every `/api/public/**` route template, derived from disk. */
function publicSegmentRoutes(): string[] {
    return collectSourceFiles({ roots: ['src/app/api/public'], floor: 1 })
        .filter((p) => p.endsWith('/route.ts'))
        .map((p) =>
            p.slice(p.indexOf('/src/app/api') + '/src/app'.length).replace(/\/route\.ts$/, ''),
        )
        .sort();
}

/** The exemption keys the sibling guard justifies, parsed from its source. */
function exemptKeys(): string[] {
    const src = readFileSync(join(ROOT, SIBLING), 'utf8');
    const start = src.indexOf('const EXEMPT');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('};', start));
    return [...block.matchAll(/^\s+'(\/api\/[^']+)'\s*:/gm)].map((m) => m[1]).sort();
}

describe('§1 every /api/public/** route is reachable at the Edge', () => {
    it('derives a non-empty population from disk', () => {
        // The positive control. An empty selection passes every assertion
        // below, and `collectSourceFiles`'s own floor is the backstop rather
        // than the detector — so the count is printed here.
        const routes = publicSegmentRoutes();
        expect({ count: routes.length, routes }).toEqual({
            count: routes.length,
            routes,
        });
        expect(routes.length).toBeGreaterThanOrEqual(2);
    });

    it('none of them is refused by isPublicPath', () => {
        const refused = publicSegmentRoutes().filter((r) => !isPublicPath(r));

        // THE #1745 ASSERTION. `/api/public/notices` sat here for seven weeks
        // with a written legal justification one file away.
        expect(refused).toEqual([]);
    });
});

describe('§2 every route justified as anonymous is reachable at the Edge', () => {
    it('parses a non-empty exemption map from the sibling guard', () => {
        // A parse that stopped matching would make §2 vacuous and look green.
        expect(exemptKeys().length).toBeGreaterThanOrEqual(4);
    });

    it('none of the exempted routes is refused by isPublicPath', () => {
        const refused = exemptKeys().filter((r) => !isPublicPath(r));

        // A route the repo has argued is anonymous, and the Edge refuses, is
        // either a dead surface or a broken duty. Both are worth failing on.
        expect(refused).toEqual([]);
    });
});

describe('§3 the guard can fail', () => {
    it('isPublicPath still refuses a tenant route', () => {
        // Mutation-proof in place: if `isPublicPath` ever returned true for
        // everything, §1 and §2 would pass over a wide-open Edge and this is
        // the assertion that notices.
        expect(isPublicPath('/api/t/acme/journal')).toBe(false);
        expect(isPublicPath('/api/me/farms')).toBe(false);
    });
});

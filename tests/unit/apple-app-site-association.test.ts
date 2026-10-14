/**
 * `/.well-known/apple-app-site-association` is served, and claims nothing yet
 * (#1763, #1623).
 *
 * ## Both halves, because one without the other is still broken
 *
 * The document AND the Edge exemption. Adding the route without the exemption
 * reproduces the 307 exactly — the handler never runs — which is the shape
 * that hit SCIM, the `iflk_` key, all three signed webhooks, the
 * platform-admin key and the Art 16 notice form that answered 401 for seven
 * weeks. A closed door and an empty queue look identical from inside.
 *
 * ## The empty claim is the DESIGN, not an omission
 *
 * #1623's argument is the deciding one: an AASA file is a published claim that
 * the listed paths open the app, Apple caches it, and a path that opens
 * nothing sends someone into the app and into a dead end — worse than the
 * browser fallback. `/c` and `/l` have no defined meaning anywhere in this
 * repo and that is an owner decision; `/f` and `/m` would open screens that do
 * not exist (P6.5, P8).
 *
 * So the emptiness is asserted rather than tolerated: a future change that
 * adds a path has to come here and say so.
 */
import { GET } from '@/app/.well-known/apple-app-site-association/route';
import {
    APP_ID,
    APPLINK_COMPONENTS,
    buildAppSiteAssociation,
} from '@/lib/ios/app-site-association';
import { isPublicPath } from '@/lib/auth/guard';

const PATH = '/.well-known/apple-app-site-association';

describe('the document lives in lib, not in the route module', () => {
    it('the route module exports only a handler and segment config', () => {
        // `tests/guards/app-router-module-exports.test.ts` enforces this and
        // caught the first version of this route, which exported APP_ID and
        // APPLINK_COMPONENTS. The violation is invisible to `tsc --noEmit` on
        // a clean checkout — Next's type constraints live in `.next/types`,
        // which only a build creates — which is why three such exports had
        // accumulated on main before that guard existed.
        //
        // Asserted here as well so the reason travels with THIS route: the
        // constants are importable from lib, so there is no reason to reach
        // for the route module and no hint that doing so breaks a build.
        expect(typeof buildAppSiteAssociation).toBe('function');
        expect(buildAppSiteAssociation()).toEqual({
            applinks: { details: [{ appIDs: [APP_ID], components: [] }] },
            webcredentials: { apps: [APP_ID] },
        });
    });
});

describe('the Edge admits the path Apple fetches', () => {
    it('isPublicPath is true for it', () => {
        // Without this the middleware 307s to /login and the handler below
        // never runs, which is the whole defect.
        expect(isPublicPath(PATH)).toBe(true);
    });

    it('and does NOT open the rest of /.well-known/', () => {
        // EXACT, not a prefix. A prefix would open every method on everything
        // beneath the segment — and the sibling entry one line up in
        // `guard.ts` is the cautionary tale for getting exactly this wrong,
        // where a SIBLING probe could not tell the two forms apart and only a
        // CHILD could. So both are checked here.
        expect(isPublicPath('/.well-known/other')).toBe(false);
        expect(isPublicPath('/.well-known/security.txt')).toBe(false);
        expect(isPublicPath(`${PATH}/child`)).toBe(false);
        expect(isPublicPath(`${PATH}extra`)).toBe(false);
    });

    it('the guard still discriminates — resolving-power control', () => {
        // An `isPublicPath` that answered true to everything would make the
        // first assertion vacuous and the second red; one that answered false
        // to everything, the reverse. Pin a known public and a known private.
        expect(isPublicPath('/login')).toBe(true);
        expect(isPublicPath('/api/t/acme/journal')).toBe(false);
    });
});

describe('the document Apple receives', () => {
    it('answers 200 with application/json', async () => {
        // Apple fetches this unauthenticated from its CDN and requires JSON
        // with no redirect. The content type is why this is a route handler
        // rather than an extensionless file under `public/`, which would be
        // served as application/octet-stream.
        const res = await GET();

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });

    it('associates the app id from the owner s Apple account', async () => {
        const body = await (await GET()).json();

        expect(body.applinks.details[0].appIDs).toEqual([APP_ID]);
        // `<team>.<bundle>`, and the shape is asserted rather than just the
        // value: a bare bundle id with no team prefix is the mistake that
        // makes Apple reject the file, and it looks plausible.
        expect(APP_ID).toMatch(/^[A-Z0-9]{10}\.[a-z0-9.]+$/);
        expect(APP_ID).toBe('9423GKWL67.bg.agrent.app');
    });

    it('claims NO applink paths, deliberately', async () => {
        const body = await (await GET()).json();

        // #1623: a published path that opens nothing is worse than no claim at
        // all, and Apple caches the document. `/c` and `/l` are undefined and
        // the `/f` and `/m` screens are unbuilt, so there is nothing honest to
        // list. A change that adds one must edit this assertion, which is the
        // point of asserting emptiness instead of ignoring the field.
        expect(body.applinks.details[0].components).toEqual([]);
        expect(APPLINK_COMPONENTS).toEqual([]);
    });

    it('DOES claim webcredentials, which is true today', async () => {
        const body = await (await GET()).json();

        // Unlike the paths, this claims nothing about screens: it lets iOS
        // offer Password AutoFill and associate saved credentials for this
        // origin with the app, and the app already signs people in here.
        expect(body.webcredentials.apps).toEqual([APP_ID]);
    });

    it('is valid JSON with no surprises at the top level', async () => {
        const body = await (await GET()).json();

        // Apple parses the whole document; an unexpected top-level key is not
        // fatal but a MISSING `applinks` is. Asserted as an exact key set so a
        // future addition is deliberate.
        expect(Object.keys(body).sort()).toEqual(['applinks', 'webcredentials']);
    });
});

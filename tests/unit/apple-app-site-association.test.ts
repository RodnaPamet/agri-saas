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
import { collectSourceFiles } from '../helpers/collect-files';

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
        // Composed FROM the exported constants, not a second copy of them.
        //
        // This assertion used to hardcode `components: []`, so it failed the
        // moment the claim changed — a test whose NAME is about module
        // exports, failing on document content. A reader trusting the name
        // would not look here, and the content is asserted on its own below,
        // against the response Apple actually fetches.
        expect(buildAppSiteAssociation()).toEqual({
            applinks: { details: [{ appIDs: [APP_ID], components: [...APPLINK_COMPONENTS] }] },
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

    it('claims exactly the five prefixes the owner named, and nothing else', async () => {
        const body = await (await GET()).json();

        // Was `toEqual([])`, and the change of answer is the whole history of
        // this field. #1623 held it empty because `/c` and `/l` had no defined
        // meaning and because agrent-ios asked that the decision come from the
        // owner DIRECTLY — it was then filled in twice on a relay, reached
        // production once, and was reverted by #1791. The owner answered
        // directly on 2026-10-14: claim all five.
        //
        // An EXACT list, so adding a sixth is a visible diff rather than a
        // side effect — which is what kept the two relayed attempts
        // reviewable.
        const expected = [
            { '/': '/f/*' },
            { '/': '/l/*' },
            { '/': '/c/*' },
            { '/': '/go/*' },
            { '/': '/m/*' },
        ];
        expect(APPLINK_COMPONENTS).toEqual(expected);
        // And the same list actually reaches the wire — the module and the
        // response are separate facts, and only the second is what Apple
        // fetches.
        expect(body.applinks.details[0].components).toEqual(expected);
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

/**
 * Two rules about WHAT may be claimed, carried over from #1780's guard when
 * the two implementations of this path were reconciled into one.
 *
 * Both hold trivially while `APPLINK_COMPONENTS` is empty, which is why each
 * carries a POSITIVE CONTROL: the same expression is applied to a synthetic
 * claim that SHOULD be caught. Without that, these would be two assertions
 * that pass over nothing and start passing over something later without ever
 * having been shown to work.
 *
 * They matter when the list stops being empty — which is a decision for the
 * owner (#1623), not for this file.
 */
describe('what may be claimed, once anything is', () => {
    /** `*`, or a `NOT …` carve-out, which only makes sense out of a catch-all. */
    const catchAlls = (claims: ReadonlyArray<Record<string, unknown>>): unknown[] =>
        claims.flatMap((c) =>
            Object.values(c).filter(
                (v) => v === '*' || (typeof v === 'string' && v.startsWith('NOT ')),
            ),
        );

    it('claims no catch-all', () => {
        expect(catchAlls(APPLINK_COMPONENTS)).toEqual([]);
        // POSITIVE CONTROL. #1780's first version of this document claimed
        // `["NOT /api/*", "*"]` — every page on the origin — and the app has
        // no URL handler, so a claimed link would have launched it at its
        // home screen and the page would never open: every emailed invite,
        // every password reset, every `/t/<slug>/…` link one farmer sends
        // another. Worse than no Universal Links, shipping as a fix.
        expect(catchAlls([{ '/': '*' }, { '/': 'NOT /api/*' }])).toHaveLength(2);
    });

    /** A claimed prefix that already serves a web page the app cannot open. */
    const collisions = (claims: ReadonlyArray<Record<string, unknown>>): string[] => {
        const pages = collectSourceFiles({ roots: ['src/app'], extensions: ['.tsx'] })
            .map((f) => f.replace(/\\/g, '/'))
            .filter((f) => f.endsWith('/page.tsx'));
        const segments = [
            ...new Set(
                pages
                    .map((f) => f.split('src/app/')[1]?.split('/')[0])
                    .filter((seg): seg is string => Boolean(seg))
                    .filter((seg) => !seg.startsWith('(') && !seg.startsWith('[') && seg !== 'api'),
            ),
        ];
        // The collector refuses an empty result, but not an empty DERIVATION.
        expect(segments.length).toBeGreaterThan(3);
        const values = claims.flatMap((c) => Object.values(c)).filter((v): v is string => typeof v === 'string');
        return segments.filter((seg) => values.some((v) => v === `/${seg}` || v.startsWith(`/${seg}/`)));
    };

    it('claims no prefix that already serves a page', () => {
        expect(collisions(APPLINK_COMPONENTS)).toEqual([]);
        // POSITIVE CONTROL, and the live example: `/invite/<token>` is a real
        // return value of both invite usecases. Claiming it would send every
        // emailed invitation into an app that cannot open it.
        expect(collisions([{ '/': '/invite/*' }])).toEqual(['invite']);
    });

    it('claims only prefixes that serve no page yet, which is what makes it payable', () => {
        // The cost of publishing ahead of the handlers: none of the five
        // serves a web page, so a tapped link today opens the app at its home
        // screen instead of rendering a 404 in Safari. The owner accepted that
        // so the client can build against a published list.
        //
        // It becomes a REGRESSION the day one of them ships as a web route
        // while the app still cannot open it — a working page starts being
        // hijacked. That is what the collision check above catches, derived
        // from the filesystem, and this case states the condition the
        // acceptance rests on so the two cannot drift apart silently.
        expect(collisions(APPLINK_COMPONENTS)).toEqual([]);
        expect(APPLINK_COMPONENTS.length).toBe(5);
    });
});

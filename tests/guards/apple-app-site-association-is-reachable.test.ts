/**
 * The Universal Links association document is SERVED, TYPED and NOT REDIRECTED
 * (#1763).
 *
 * Apple's CDN fetches `/.well-known/apple-app-site-association` with no
 * credential and decides from it whether a link may open the app. It must be
 * 200, `application/json`, and never a redirect.
 *
 * Before this landed, nothing served the path at all — no route, no file, no
 * exemption — so the Edge sent it to `/login` and **no link to this domain
 * could open the iOS app**. Measured on production:
 *
 *     307 -> /login?next=%2F.well-known%2Fapple-app-site-association
 *
 * ## Why this guard checks three things and not one
 *
 * The feature needs all three, and each fails SILENTLY on its own — the
 * document looks fine in the repo in every broken combination:
 *
 *   1. the file exists and is valid JSON naming the app id;
 *   2. `isPublicPath` admits the path, or the Edge redirects before the file
 *      is ever served;
 *   3. `next.config.js` sets `Content-Type: application/json`, because the
 *      path has NO EXTENSION (Apple's requirement) and static serving cannot
 *      infer a type for it.
 *
 * Shipping 1 without 2 reproduces the original 307 exactly. Shipping 1 and 2
 * without 3 serves the right bytes under a type Apple will not accept. None
 * of the three is visible in the others.
 *
 * ## What this guard does NOT prove
 *
 * That production serves it. These are repo-level facts: a file, a set, and a
 * config entry. The live check is the same `curl` quoted above returning 200
 * with `content-type: application/json`, and it has to be run AFTER a deploy —
 * serve it, verify on the live response, then tell the client, which is the
 * ordering #1156 established.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isPublicPath } from '@/lib/auth/guard';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AASA_PATH = '/.well-known/apple-app-site-association';
const FILE = path.join(REPO_ROOT, 'public', '.well-known', 'apple-app-site-association');

/** The entitlement the iOS client ships (agrent-ios#206). */
const APP_ID = '9423GKWL67.bg.agrent.app';

describe('the Apple app-site-association document is reachable and typed', () => {
    it('exists and is valid JSON', () => {
        expect(fs.existsSync(FILE)).toBe(true);
        expect(() => JSON.parse(fs.readFileSync(FILE, 'utf8'))).not.toThrow();
    });

    it('names the app id, under applinks', () => {
        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const details = doc?.applinks?.details;
        expect(Array.isArray(details)).toBe(true);
        expect(details.map((d: { appID?: string }) => d.appID)).toContain(APP_ID);
    });

    it('claims ONLY the prefixes the app is built to open', () => {
        // The agreed set (agrent-ios#206). Deliberately an exact list, so
        // widening it is a visible diff and a conversation rather than a
        // side effect — each prefix gets its `onOpenURL` on the phone as the
        // corresponding web route ships.
        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const entry = doc.applinks.details.find(
            (d: { appID?: string }) => d.appID === APP_ID,
        );
        expect(entry.paths).toEqual(['/f/*', '/l/*', '/go/*', '/c/*', '/m/*']);
    });

    it('claims no catch-all, which would hand the whole site to the app', () => {
        // THE REGRESSION THIS FILE EXISTS FOR, after the reachability itself.
        //
        // The first version of this document claimed `["NOT /api/*", "*"]` —
        // every page on the domain. The entitlement `applinks:app.agrent.bg`
        // ships on every installed build while the app has no
        // `onOpenURL` / `onContinueUserActivity` handler, so a claimed link
        // LAUNCHES THE APP AT ITS HOME SCREEN and the page never opens.
        //
        // That would have broken, for anyone with the app installed, every
        // emailed invite (`/invite/<token>`, `/invite/org/<token>`), every
        // password reset, `/login`, `/accept-terms`, and any `/t/<slug>/…`
        // page one farmer sends another. Strictly worse than no Universal
        // Links at all, which is the state it was fixing.
        //
        // Caught by agrent-ios reading the claim against its own URL
        // handling — the half of this that cannot be checked from here.
        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const d of doc.applinks.details) {
            for (const claim of d.paths as string[]) {
                expect(claim).not.toBe('*');
                // `NOT …` entries only make sense alongside a catch-all; on
                // their own they claim nothing. Their presence means someone
                // is carving exceptions out of "everything".
                expect(claim.startsWith('NOT ')).toBe(false);
            }
        }
    });

    it('claims no path that already serves a web page', () => {
        // Derived from the filesystem, so a future web route under a claimed
        // prefix fails here rather than silently becoming unreachable on a
        // phone.
        //
        // If this fails because a genuine route shipped under a claimed
        // prefix, the fix is NOT to delete the claim: it is to confirm the
        // app parses that URL and then record it here. A claim the app does
        // not handle is a page nobody can open; a page the app handles and
        // does not claim is merely a missed deep link.
        const appDir = path.join(REPO_ROOT, 'src', 'app');
        const topLevel = fs
            .readdirSync(appDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            // Route groups `(app)` and dynamic `[slug]` are not literal URL
            // segments; `api` is server-only and never a page.
            .filter((n) => !n.startsWith('(') && !n.startsWith('[') && n !== 'api');

        expect(topLevel.length).toBeGreaterThan(3); // the walk still finds routes

        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const claims: string[] = doc.applinks.details.flatMap(
            (d: { paths: string[] }) => d.paths,
        );
        const collisions = topLevel.filter((seg) =>
            claims.some((c) => c === `/${seg}` || c.startsWith(`/${seg}/`)),
        );
        expect(collisions).toEqual([]);
    });

    it('is admitted by the Edge, which is what the 307 was', () => {
        // The half that was missing. Without it the handler/file is never
        // reached and the association silently fails.
        expect(isPublicPath(AASA_PATH)).toBe(true);
    });

    it('does NOT open the rest of /.well-known/', () => {
        // EXACT, not a prefix: opening the segment would admit whatever lands
        // under it next without anyone deciding to.
        expect(isPublicPath('/.well-known/openid-configuration')).toBe(false);
        expect(isPublicPath('/.well-known/')).toBe(false);
    });

    it('is served as application/json, which an extensionless file is not by default', () => {
        // Apple requires the type. The path has no extension precisely
        // because Apple requires that too, so nothing can infer it.
        const config = fs.readFileSync(path.join(REPO_ROOT, 'next.config.js'), 'utf8');
        const idx = config.indexOf(AASA_PATH);
        expect(idx).toBeGreaterThan(-1);
        // The header must belong to THIS source block, not merely exist
        // somewhere in the file — a Content-Type set on another route would
        // satisfy a naive search while this path stayed untyped.
        const block = config.slice(idx, idx + 400);
        expect(block).toMatch(/key:\s*'Content-Type'/);
        expect(block).toMatch(/value:\s*'application\/json'/);
    });
});

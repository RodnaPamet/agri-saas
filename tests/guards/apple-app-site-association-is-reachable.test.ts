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

    it('excludes /api/* from opening the app', () => {
        // An API call must never launch the app instead of answering. Apple
        // evaluates `paths` in order, so the exclusion has to come first.
        const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const entry = doc.applinks.details.find(
            (d: { appID?: string }) => d.appID === APP_ID,
        );
        expect(entry.paths[0]).toBe('NOT /api/*');
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

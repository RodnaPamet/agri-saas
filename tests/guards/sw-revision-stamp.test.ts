/**
 * `SW_REVISION` must be a content hash of `public/sw.js` itself.
 *
 * The service worker has no version identifier otherwise. `CACHE_VERSION` is a
 * hand-written brand literal that no build varies (its own comment says so),
 * and `BUILD_SHA` cannot reach the worker: it is a runner-stage ENV declared
 * after `next build`, read only by the health routes, not `NEXT_PUBLIC_*`, and
 * nothing templates `public/sw.js` at build time.
 *
 * WHY A CONTENT HASH AND NOT A PER-DEPLOY VALUE, which is the whole point of
 * this guard. New bytes in `sw.js` mean a new worker, and a new worker means an
 * "Update ready — refresh" prompt, because install deliberately skips
 * `skipWaiting` so a deploy never hot-swaps under an operator mid-queue on
 * flaky signal. Stamping `BUILD_SHA` here would republish the worker on EVERY
 * deploy rather than on the handful of commits that touch this file — a change
 * to how often operators are interrupted, smuggled in as instrumentation.
 *
 * So the identifier must change exactly when the file changes, and this guard
 * is what keeps it honest: forget to update it after editing `sw.js` and CI
 * says so, printing the value to paste.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SW_PATH = path.join(process.cwd(), 'public/sw.js');
const DECL = /const SW_REVISION = '([0-9a-f]{12})';/g;

function read(): string {
    return fs.readFileSync(SW_PATH, 'utf8');
}

/** The hash the declaration should carry: this file with the value blanked. */
function expectedRevision(src: string): string {
    const canonical = src.replace(/const SW_REVISION = '[0-9a-fA-FX]+';/, "const SW_REVISION = '<<REVISION>>';");
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}

describe('public/sw.js carries a content-hash revision stamp', () => {
    it('declares SW_REVISION exactly once, as 12 lowercase hex', () => {
        const matches = [...read().matchAll(DECL)];
        expect(matches).toHaveLength(1);
    });

    it('the stamp matches this file s content', () => {
        const src = read();
        const found = [...src.matchAll(DECL)][0]?.[1];
        const want = expectedRevision(src);
        // Printed so the fix is a paste rather than a hunt.
        expect(`SW_REVISION=${found}`).toBe(`SW_REVISION=${want}`);
    });

    // The stamp is only worth anything if it is REACHABLE — the page has no
    // other way to learn which worker is running. #922's lesson: a complete
    // mechanism mounted nowhere is not a mechanism.
    it('is reported back over the message channel', () => {
        const src = read();
        expect(src).toMatch(/event\.data\.type === 'SW_VERSION'/);
        expect(src).toMatch(/postMessage\(\{\s*type:\s*'SW_VERSION',\s*revision:\s*SW_REVISION\s*\}\)/);
    });

    // The measurement must not become a policy change. A per-deploy value here
    // would prompt every operator on every deploy.
    it('is not derived from a per-deploy value', () => {
        const src = read();
        const decl = src.slice(src.indexOf('const SW_REVISION'), src.indexOf('const SW_REVISION') + 120);
        expect(decl).not.toMatch(/BUILD_SHA|process\.env|Date\.now/);
    });

    // The version reply must stay READ-ONLY. Answering a question must never
    // activate the waiting worker — that is the operator's consent to give.
    it('answering SW_VERSION does not skipWaiting', () => {
        const src = read();
        const start = src.indexOf("event.data.type === 'SW_VERSION'");
        expect(start).toBeGreaterThan(-1);
        const arm = src.slice(start, src.indexOf('}', src.indexOf('postMessage', start)));
        expect(arm).not.toMatch(/skipWaiting/);
    });
});

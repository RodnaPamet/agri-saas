/**
 * A `NEXT_PUBLIC_*` the code reads must be passable at BUILD time — #2009.
 *
 * This is #2009's option 2, and it would have caught its instance 2 outright:
 * `NEXT_PUBLIC_NOTIFICATIONS_SSE` gated the notifications stream, appeared in
 * no Dockerfile `ARG` and no publish build-arg, and so was baked `undefined`
 * into every image ever built. Not off — **unsettable**, while the comment
 * above it claimed "future opt-in is one env-var flip".
 *
 * Unlike option 1 (feature-flag rows, shipped in #2294 and necessarily checked
 * against production), this one is entirely static: three files in the repo,
 * compared. So it belongs in CI, where it fails the PR that introduces the gap
 * rather than reporting it after a deploy.
 *
 * ## The chain a value has to survive
 *
 * Next inlines `NEXT_PUBLIC_*` into the client bundle at `next build`, reading
 * it from the build environment. So every link must hold:
 *
 *   1. the publish workflow passes `--build-arg KEY=…`;
 *   2. the Dockerfile declares `ARG KEY`, or the build-arg is discarded;
 *   3. the Dockerfile promotes it with `ENV KEY=$KEY`, or the ARG is invisible
 *      to the build process;
 *   4. that `ENV` comes BEFORE the build step, or it is set too late to inline.
 *
 * A break anywhere is silent and produces the same symptom: a feature that is
 * code-complete, green in CI, and dead in production.
 *
 * ## Why the keys are read from comment-stripped source
 *
 * `src/env.ts` carries the line "NEXT_PUBLIC_VAPID_PUBLIC_KEY was HERE and is
 * deliberately gone" — a scar, not a declaration. VAPID now flows as a server
 * prop instead. A naive grep reads that comment as a live key and demands a
 * build-arg for a variable the code stopped using, which is how a guard starts
 * costing more than it saves.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/** Blank out comments, preserving line count so offsets stay meaningful. */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
        .replace(/\/\/[^\n]*/g, '');
}

const KEY_RE = /NEXT_PUBLIC_[A-Z0-9_]+/g;

/**
 * Keys that are DECLARED but deliberately never passed to a production build.
 *
 * Each needs a reason, and the reason has to be about the production build
 * rather than about effort — an entry here says "a production image is correct
 * without this", which is a claim.
 */
const NOT_IN_PRODUCTION_BUILDS: Record<string, string> = {
    NEXT_PUBLIC_MAP_BASEMAP_FIXTURE:
        'An E2E fixture switch: it makes the map serve local fixture tiles instead of '
        + 'reaching MapTiler, so the basemap specs run without a key or a network. Passing '
        + 'it to a production build would ship a client that renders fixture tiles to '
        + 'farmers. Its server-side half is `E2E_BASEMAP_FIXTURE_TILES`, which is '
        + 'deliberately separate for the same reason.',
};

const envSrc = stripComments(read('src/env.ts'));
const dockerfile = read('Dockerfile');
const publish = read('.github/workflows/ghcr-publish.yml');

const declared = [...new Set(envSrc.match(KEY_RE) ?? [])].sort();

describe('a NEXT_PUBLIC_* the code reads can be set at build time (#2009)', () => {
    it('ranges over a real population — the denominator', () => {
        // Without this the suite below passes vacuously if the extraction ever
        // breaks: zero keys means zero failures.
        expect(declared.length).toBeGreaterThanOrEqual(5);
        // And the extraction must see the ones we know are live.
        expect(declared).toEqual(expect.arrayContaining([
            'NEXT_PUBLIC_MAPTILER_KEY',
            'NEXT_PUBLIC_SENTRY_DSN',
        ]));
    });

    it('does NOT read a key out of a comment — the scar control', () => {
        // `src/env.ts` names NEXT_PUBLIC_VAPID_PUBLIC_KEY in a comment saying it
        // is deliberately gone. If comment-stripping regresses, this guard would
        // demand a build-arg for a variable nothing reads.
        expect(read('src/env.ts')).toContain('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
        expect(declared).not.toContain('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
    });

    it.each(declared.filter((k) => !(k in NOT_IN_PRODUCTION_BUILDS)))(
        '%s survives the whole chain into the client bundle',
        (key) => {
            // 1 — the publish workflow passes it.
            expect(publish).toMatch(new RegExp(`${key}=`));
            // 2 — the Dockerfile accepts it.
            expect(dockerfile).toMatch(new RegExp(`^ARG\\s+${key}`, 'm'));
            // 3 — and promotes it, or the ARG never reaches the build process.
            expect(dockerfile).toMatch(new RegExp(`^ENV\\s+${key}=\\$${key}`, 'm'));
        },
    );

    it('every promotion happens BEFORE the build, not after', () => {
        // The link that fails silently and looks correct in a diff: an ENV after
        // `next build` sets a variable the bundle was already compiled without.
        const lines = dockerfile.split('\n');
        const buildAt = lines.findIndex((l) => /^RUN\s+npx next build/.test(l));
        expect(buildAt).toBeGreaterThan(0);

        const late = declared
            .filter((k) => !(k in NOT_IN_PRODUCTION_BUILDS))
            .map((k) => ({ k, at: lines.findIndex((l) => new RegExp(`^ENV\\s+${k}=`).test(l)) }))
            .filter(({ at }) => at === -1 || at > buildAt);
        expect(late).toEqual([]);
    });

    it('every exemption names a real key and gives a production reason', () => {
        for (const [key, reason] of Object.entries(NOT_IN_PRODUCTION_BUILDS)) {
            // An exemption for a key nothing declares is an excuse that outlived
            // its subject.
            expect(declared).toContain(key);
            expect(reason.length).toBeGreaterThan(80);
        }
    });
});

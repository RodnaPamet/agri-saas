import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `BUILD_SHA` reaches the running container through a chain, and every link
 * fails SILENTLY when severed — the response falls back to `'dev'`, which is
 * exactly what a correctly-built image with no commit stamp also returns.
 *
 *   ghcr-publish.yml  --build-arg-->  Dockerfile ARG  -->  ENV  -->  /api/health
 *
 * Production reported `"version":"dev"` for the life of the deployment, and on
 * 2026-09-08 that turned "is production running main's tip?" into a 1630-line
 * build-log read. Refs #804.
 *
 * All three links are now asserted. #837 landed the `--build-arg` in
 * `ghcr-publish.yml`; this PR adds the `ARG`/`ENV` that consumes it. Between
 * those two merges `main` sat in the asymmetric state below — a build-arg
 * passed to a Dockerfile with no matching ARG, which Docker DISCARDS SILENTLY,
 * leaving `"version":"dev"` and no error anywhere. That window is exactly why
 * the asymmetry is guarded rather than assumed.
 */

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const DOCKERFILE = read('Dockerfile');
const PUBLISH = read('.github/workflows/ghcr-publish.yml');

/** Line index of a pattern, or -1. */
function lineOf(src: string, re: RegExp): number {
    return src.split('\n').findIndex((l) => re.test(l));
}

describe('BUILD_SHA reaches the image', () => {
    it('the Dockerfile has the stages this guard reasons about', () => {
        // Positive control. Every ordering assertion below is meaningless if
        // the stage markers are absent — findIndex would return -1 and the
        // comparisons would quietly compare two -1s.
        expect(lineOf(DOCKERFILE, /^FROM .* AS builder/)).toBeGreaterThan(-1);
        expect(lineOf(DOCKERFILE, /^FROM .* AS runner/)).toBeGreaterThan(-1);
    });

    it('declares ARG BUILD_SHA and promotes it to ENV', () => {
        expect(DOCKERFILE).toMatch(/^ARG BUILD_SHA=/m);
        expect(DOCKERFILE).toMatch(/^ENV BUILD_SHA=\$BUILD_SHA/m);
    });

    it('declares it in the RUNNER stage, not the builder', () => {
        // Not style. An ARG in the builder stage joins the cache key for
        // `next build`, so a new sha every commit would invalidate that layer
        // on every commit — against cache-from/cache-to type=gha, that is the
        // expensive layer.
        const runner = lineOf(DOCKERFILE, /^FROM .* AS runner/);
        const arg = lineOf(DOCKERFILE, /^ARG BUILD_SHA=/);
        expect(arg).toBeGreaterThan(runner);
    });

    it('both health surfaces read it', () => {
        for (const route of ['src/app/api/health/route.ts', 'src/app/api/readyz/route.ts']) {
            expect(read(route)).toMatch(/process\.env\.BUILD_SHA/);
        }
    });

    it('the publish workflow passes the build-arg', () => {
        // The first link, now that #837 has landed it. Asserted
        // UNCONDITIONALLY — an earlier draft made this an `if (workflow has
        // BUILD_SHA)` implication, which was honest while the link genuinely
        // did not exist but becomes a vacuous pass the moment someone deletes
        // the line it was waiting for.
        expect(PUBLISH).toMatch(/BUILD_SHA=\$\{\{ github\.sha \}\}/);
        expect(PUBLISH).toMatch(/build-args:/);
    });

    it('neither half can be removed without the other failing', () => {
        // Docker DISCARDS a --build-arg with no matching ARG, silently. So
        // half a chain and no chain at all produce the identical observable:
        // "version":"dev". Both directions must be load-bearing.
        const workflowPasses = /BUILD_SHA=\$\{\{ github\.sha \}\}/.test(PUBLISH);
        const dockerfileConsumes = /^ARG BUILD_SHA=/m.test(DOCKERFILE)
            && /^ENV BUILD_SHA=\$BUILD_SHA/m.test(DOCKERFILE);
        expect(workflowPasses).toBe(dockerfileConsumes);
        expect(workflowPasses).toBe(true);
    });
});

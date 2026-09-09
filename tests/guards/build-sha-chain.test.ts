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
 * WHAT THIS FILE DOES NOT YET GUARD, stated so it is not mistaken for full
 * coverage: the first link. The `--build-arg` lives in `ghcr-publish.yml`,
 * which is being rewritten in #837 and carries the line there. Until that
 * lands the chain is incomplete BY DESIGN and the response still says `'dev'`.
 * The remainder is tracked as its own issue rather than left in a PR body.
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

    it('if the workflow passes the build-arg, the Dockerfile must consume it', () => {
        // The dangerous asymmetry, guarded ahead of #837: a workflow that
        // passes --build-arg BUILD_SHA into a Dockerfile with no matching ARG
        // is silently discarded by Docker, and the response still says 'dev'.
        // This implication is currently vacuous — the workflow does not pass
        // it yet — which is safe ONLY because the Dockerfile half is asserted
        // unconditionally above. Do not collapse these into one conditional.
        if (/BUILD_SHA/.test(PUBLISH)) {
            expect(DOCKERFILE).toMatch(/^ARG BUILD_SHA=/m);
            expect(DOCKERFILE).toMatch(/^ENV BUILD_SHA=\$BUILD_SHA/m);
        }
    });
});

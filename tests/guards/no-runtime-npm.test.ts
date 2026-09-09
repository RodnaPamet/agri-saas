/**
 * The runtime image ships no npm — and nothing at runtime may assume it.
 *
 * Trivy blocks the build on CRITICAL/HIGH findings, and the ones it kept
 * flagging did not belong to us: they lived in the npm CLI bundled inside
 * `node:22-alpine` at `/usr/local/lib/node_modules/npm` (a CRITICAL tar
 * gzip-bomb DoS, CVE-2026-59873, plus HIGH brace-expansion / js-yaml). They are
 * unreachable from application code and unfixable from our package-lock,
 * because they are the base image's dependencies, not ours.
 *
 * The fix was to delete the CLI rather than suppress the finding: nothing in
 * the runtime needs it once the entrypoint calls the VENDORED
 * `./node_modules/.bin/prisma` (`prisma` is a production dependency, so it is
 * already in the image — the old `npx --yes prisma@7.8.0` was re-downloading a
 * package that was sitting on disk).
 *
 * This guard locks both halves in. The failure mode it prevents is silent and
 * only shows up in production: a re-introduced `npx` in a startup path runs
 * fine in dev and in CI — where npm exists — and then dies at container start
 * with "npx: not found".
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('no npm in the runtime image', () => {
    const dockerfile = read('Dockerfile');
    const entrypoint = read('scripts/entrypoint.sh');

    it('the Dockerfile strips the bundled npm CLI', () => {
        expect(dockerfile).toMatch(/rm -rf[\s\S]{0,80}\/usr\/local\/lib\/node_modules\/npm/);
    });

    it('strips the npx shim too, not just npm', () => {
        // Leaving /usr/local/bin/npx behind would keep a dangling symlink that
        // fails confusingly rather than cleanly.
        expect(dockerfile).toContain('/usr/local/bin/npx');
    });

    it('the entrypoint runs the vendored Prisma CLI', () => {
        expect(entrypoint).toContain('./node_modules/.bin/prisma migrate deploy');
    });

    it('no startup path shells out to npx', () => {
        // Comments are allowed to mention npx (the reasoning is written down);
        // an executable line is not.
        const offending = entrypoint
            .split('\n')
            .filter((l) => !l.trim().startsWith('#'))
            .filter((l) => /\bnpx\b|\bnpm\b/.test(l));
        expect(offending).toEqual([]);
    });

    it('prisma stays a production dependency — the vendored binary depends on it', () => {
        // If prisma moved to devDependencies, `npm ci --omit=dev` would prune
        // it out of the image and the entrypoint would break with no npx to
        // fall back on.
        const pkg = JSON.parse(read('package.json')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        expect(pkg.dependencies?.prisma).toBeDefined();
        expect(pkg.devDependencies?.prisma).toBeUndefined();
    });
});

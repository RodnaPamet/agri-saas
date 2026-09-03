/**
 * `package-lock.json` must not lose its `libc` entries.
 *
 * ## What this cost
 *
 * `libc` is a package.json field, sibling to `os` and `cpu`, that restricts a
 * package to a libc family. npm records it in the lockfile and uses it to
 * FILTER optional platform binaries — `@img/sharp-*` and `@swc/core-*` ship
 * separate glibc and musl builds.
 *
 * **npm 10 silently deletes those entries; npm 11 preserves them.** Measured
 * from a clean tree (this repo's package.json + .npmrc + a 22-entry lockfile,
 * no node_modules):
 *
 *     npm 10.9.8  full install         ->  0    strips
 *     npm 11      full install         -> 22    preserves
 *     npm 11      --package-lock-only  -> 22    preserves
 *
 * The repo's own pinned toolchain is the stripping one: `.nvmrc` says 22,
 * every Dockerfile stage is `node:22-alpine`, and Node v22.23.2 bundles npm
 * 10.9.8. So the default way to regenerate this lockfile corrupts it.
 *
 * Losing the entries does not break the build — npm loses the *filter* and
 * installs BOTH libc families, so the correct-platform binary is still there
 * and `sharp` still resolves on Alpine. It ships tens of MB of dead
 * cross-libc binaries in the production image instead. Measured on glibc and
 * on node:22-alpine: a stripped lockfile installs 1794 packages where an
 * intact one installs 1791.
 *
 * ## Why a test, and not `engines`
 *
 * Raising `engines.npm` to `>=11` is the obvious fix and is a total outage.
 * `.npmrc` already sets `engine-strict=true` (185ea4403, #382), so the floor
 * is ENFORCED at install time — and every install site runs npm 10:
 * `.github/actions/setup-node-prisma` (used by 8 CI jobs), the Security job's
 * own `npm ci`, `Dockerfile:25`, and every contributor following `.nvmrc`.
 * Measured: npm 10.9.8 exits 1 on both `npm ci` and `npm install` under that
 * floor. The floor is right in principle and unaffordable in practice.
 *
 * Pinning npm in CI does not help either, because **CI is not a producer**:
 * `npm install` appears zero times across `.github/workflows` and
 * `.github/actions` (31 `npm ci` sites), and `Dockerfile:25` is `npm ci`,
 * whose own comment says "Never `npm install` in an image build". `npm ci`
 * never writes the lockfile. The producers are contributors running
 * `npm install` locally, and Dependabot.
 *
 * ## Why nothing caught it before
 *
 * The lockfile-integrity gate (`ci.yml:1310`) is `git diff --exit-code
 * package-lock.json` run AFTER `npm ci`. Since `npm ci` never writes, a
 * committed stripped lockfile matches itself and the gate passes. That is not
 * a simulation: `main` carried a fully libc-stripped lockfile from 17e907089
 * (2026-08-21) to 785cb02bb (2026-08-31) — ten days, through merged PRs and
 * tagged releases — with `Security`, a required check, green throughout.
 *
 * Every other check in this repo asserts a property DERIVED from the lockfile
 * (does it install, does it audit clean, is it in sync with package.json).
 * This is the first that asserts a property OF it.
 *
 * ## Why a floor and not an equality
 *
 * The committed lockfile is already incomplete. Of the 85 linux-`os` packages
 * in it, 22 carry `libc` and 41 more declare it upstream with no entry
 * recorded. `22` is therefore a FLOOR over a partial record, not a target —
 * do not read it as "the correct number". The count has also been as high as
 * 44 historically, though the dependency set has changed since, so that is
 * not purely loss.
 *
 * If a legitimate dependency removal drops the count, lower `LIBC_BASELINE`
 * deliberately, in the same commit, with the reason. That is the ratchet
 * working, not failing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

type LockEntry = { libc?: string[]; os?: string[]; optional?: boolean };
const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'),
) as { packages?: Record<string, LockEntry> };

const packages = lock.packages ?? {};
const carryingLibc = Object.entries(packages).filter(([, meta]) => Array.isArray(meta.libc));
const linuxPackages = Object.entries(packages).filter(([, meta]) => (meta.os ?? []).includes('linux'));

/**
 * A FLOOR, not a target — see the docblock. Lower it only alongside a real
 * dependency removal, in the same commit, with the reason written down.
 */
const LIBC_BASELINE = 22;

const FIX = [
    'package-lock.json has lost `libc` entries.',
    '',
    'This almost always means it was regenerated with npm 10, which strips them.',
    'Check with `npm --version`. To repair:',
    '',
    '    git checkout origin/main -- package-lock.json',
    '    npx -y npm@11 install --package-lock-only',
    '    grep -c \'"libc"\' package-lock.json     # expect >= ' + LIBC_BASELINE,
    '',
    'Do NOT verify with `npm ci && git diff --exit-code package-lock.json` —',
    '`npm ci` never writes the lockfile, so that passes on a corrupt one.',
].join('\n');

describe('package-lock.json keeps its libc platform metadata', () => {
    it('finds the lockfile structure it is meant to be checking', () => {
        // Anti-vacuity. A restructured or unreadable lockfile would make the
        // real assertion below pass while checking nothing — and this guard
        // exists precisely because the previous check passed on a corrupt file.
        expect(Object.keys(packages).length).toBeGreaterThan(500);
        expect(linuxPackages.length).toBeGreaterThan(50);
    });

    it('has not dropped below the libc baseline', () => {
        // Thrown rather than asserted so the repair instructions are in the
        // failure output. `expect(n).toBeGreaterThanOrEqual(22)` alone tells
        // the reader a number moved, not that their npm is the cause.
        if (carryingLibc.length < LIBC_BASELINE) {
            throw new Error(`${FIX}\n\nfound ${carryingLibc.length}, expected >= ${LIBC_BASELINE}`);
        }
        expect(carryingLibc.length).toBeGreaterThanOrEqual(LIBC_BASELINE);
    });

    it("still covers both libc families, not just the build host's", () => {
        // A stripped-then-partially-rewritten lockfile can end up recording
        // only the family of whichever machine last wrote it. Both must be
        // present, or the filter is broken in one direction while the count
        // still looks healthy.
        const families = new Set(carryingLibc.flatMap(([, meta]) => meta.libc ?? []));
        expect(Array.from(families).sort()).toEqual(['glibc', 'musl']);
    });

    it('keeps the entries on the packages that actually ship binaries', () => {
        // The count alone could be satisfied by unrelated packages. These two
        // scopes are the ones whose binaries land in the production image.
        const scopes = new Set(
            carryingLibc.map(([p]) => p.split('node_modules/').pop()?.split('/')[0]),
        );
        expect(scopes).toContain('@img');
        expect(scopes).toContain('@swc');
    });
});

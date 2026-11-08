/**
 * The SBOM presence audit — #2884, and it is EXECUTED here rather than guarded.
 *
 * `scripts/ci/check-release-sboms.mjs` decides whether a red run gets filed
 * about a supply-chain artefact missing from a published release. A guard
 * asserting its source text would contribute nothing: the whole value is in
 * which of three verdicts it reaches, and two of the three look identical from
 * outside — `clean` and `unaudited` both have zero missing releases.
 *
 * It runs through `spawnSync`, the repo's convention for an `.mjs` checker
 * (`tests/unit/coverage-tooling/coverage-scripts.test.ts`), and that is
 * STRICTLY stronger than importing `auditReleases` would be: it covers the
 * verdict→EXIT CODE mapping too. CI never reads the verdict object; it reads
 * the exit code, and "`unaudited` exits 0" is precisely how an audit over a
 * broken listing would read as a pass.
 *
 * Four properties, and the second and third are what make the first worth
 * having:
 *
 *   1. a release with no `sbom.spdx.json` is REPORTED, and the run goes red;
 *   2. a release that has one is NOT — the positive control, without which a
 *      checker that reported everything passes case 1;
 *   3. an EMPTY listing is `unaudited` and STILL RED, because a token without
 *      `contents: read` produces zero missing releases;
 *   4. a release published SECONDS ago is not reported, because the asset is
 *      uploaded by a step after the release row exists — measured on
 *      `v12.157.0`, which read back with no assets 1m40s after publication and
 *      carried its 2,526,346-byte SBOM a minute later.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/ci/check-release-sboms.mjs');
const SBOM_ASSET = 'sbom.spdx.json';

/** 2026-11-09T12:00:00Z — clear of the floor and of any grace window. */
const NOW = '2026-11-09T12:00:00Z';
const NOW_MS = Date.parse(NOW);

/** Old enough to judge, new enough to sit above the floor. */
const SETTLED = '2026-11-08T09:05:50Z';

/** The oldest release that HAS an SBOM; the floor sits exactly on it. */
const FLOOR_ISO = '2026-10-09T19:34:41Z';

let tmp = '';
beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sbom-audit-'));
});

function release(tag: string, publishedAt: string, assets: string[]) {
    return { tag_name: tag, published_at: publishedAt, assets: assets.map((name) => ({ name })) };
}

/** Run the checker over a crafted listing. Returns the exit code and output. */
function audit(releases: unknown, extra: string[] = []) {
    const file = path.join(tmp, `releases-${Math.abs(JSON.stringify(releases).length)}-${extra.join('')}.json`);
    writeFileSync(file, JSON.stringify(releases));
    const r = spawnSync('node', [SCRIPT, '--from-file', file, '--now', NOW, ...extra], {
        encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('a missing SBOM is reported, and the run goes RED', () => {
    it('names the tag, prints the repair command, and exits non-zero', () => {
        const r = audit([
            release('v12.151.2', SETTLED, []),
            release('v12.151.1', SETTLED, [SBOM_ASSET]),
        ]);
        // The exit code is the whole contract as far as CI is concerned.
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('verdict=missing');
        expect(r.out).toContain('MISSING v12.151.2');
        // The error has to CARRY the repair, because #2884 is precisely a
        // repair instruction surviving only inside a self-closed issue's log.
        expect(r.out).toContain('sbom-backfill.yml -f tag=');
        // And the DENOMINATOR beside the count: "1 missing" over an audited
        // population of 2 and over one of 40 are different facts.
        expect(r.out).toContain('audited=2');
    });

    it('reports EVERY missing release, not just the newest', () => {
        // The four that failed on 2026-11-08 failed across four hours, so a
        // first-match-wins audit would have named one and repaired one.
        const r = audit([
            release('v12.152.0', '2026-11-08T13:08:13Z', []),
            release('v12.151.6', '2026-11-08T12:23:52Z', [SBOM_ASSET]),
            release('v12.151.5', '2026-11-08T11:49:06Z', []),
            release('v12.151.4', '2026-11-08T11:18:20Z', [SBOM_ASSET]),
            release('v12.151.3', '2026-11-08T10:16:28Z', []),
            release('v12.151.2', '2026-11-08T09:05:50Z', []),
        ]);
        expect(r.status).not.toBe(0);
        for (const tag of ['v12.152.0', 'v12.151.5', 'v12.151.3', 'v12.151.2']) {
            expect(r.out).toContain(`MISSING ${tag}`);
        }
        expect(r.out).toContain('missing=4');
        expect(r.out).toContain('audited=6');
    });
});

describe('the controls — three ways this could pass while saying nothing', () => {
    it('a release WITH an SBOM is clean and exits 0, so "missing" is not the only answer', () => {
        const r = audit([release('v12.156.0', SETTLED, [SBOM_ASSET])]);
        expect(r.status).toBe(0);
        expect(r.out).toContain('verdict=clean');
        expect(r.out).not.toContain('MISSING');
    });

    it('an EMPTY listing is unaudited and STILL RED', () => {
        // The failure this separates: zero missing releases is what a broken
        // listing produces, and it is byte-identical to a clean audit. The
        // EXIT CODE is the half that matters — an `unaudited` verdict that
        // exited 0 would be the same silence #2884 is about, one level in.
        const r = audit([]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('verdict=unaudited');
        expect(r.out).toMatch(/EMPTY/);
    });

    it('a window of ONLY too-new releases is unaudited, not clean', () => {
        // The same trap one level further in: every release skipped for a
        // legitimate reason still means nothing was checked.
        const r = audit([
            release('v12.157.0', new Date(NOW_MS - 60_000).toISOString(), []),
        ]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('verdict=unaudited');
        expect(r.out).toContain('audited=0');
        expect(r.out).toContain('skipped_too_new=1');
    });

    it('a window of ONLY pre-floor releases is unaudited, not clean', () => {
        const r = audit([release('v9.0.0', '2026-09-01T00:00:00Z', [])]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('verdict=unaudited');
        expect(r.out).toContain('skipped_before_floor=1');
    });
});

describe('the false-alarm half — a release mid-attach is not a defect', () => {
    it('does not report a release published inside the grace window', () => {
        // MEASURED on `v12.157.0`: published 22:19:03, read back with an EMPTY
        // asset list at 22:20:43, carrying 2,526,346 bytes a minute later.
        // semantic-release creates the row and a later step uploads the asset,
        // so absence genuinely means "not yet" for a window.
        //
        // Without this the `workflow_run` trigger — which fires the moment
        // Release completes — would file an issue about nearly every release,
        // and a probe that cries wolf is one people learn to ignore: the same
        // ending as the silence it was written to fix.
        const r = audit([
            release('v12.157.0', new Date(NOW_MS - 60_000).toISOString(), []),
            release('v12.156.0', SETTLED, [SBOM_ASSET]),
        ]);
        expect(r.status).toBe(0);
        expect(r.out).toContain('verdict=clean');
        expect(r.out).toContain('skipped_too_new=1');
        expect(r.out).toContain('audited=1');
    });

    it('DOES report the same release once the grace window has passed', () => {
        // The other direction, and what stops the grace window being a
        // permanent exemption: the identical row, judged later, is a defect.
        const r = audit([
            release('v12.157.0', new Date(NOW_MS - 60 * 60 * 1000).toISOString(), []),
        ]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('MISSING v12.157.0');
    });

    it('ignores releases that predate the SBOM step rather than failing for ever', () => {
        // The floor is DERIVED: measured over every release this repo has, the
        // oldest carrying an SBOM is v10.5.3 at 2026-10-09T19:34:41Z. Without
        // a floor the window slides back into releases that never had one and
        // the audit goes permanently red — a probe nobody can fix.
        const r = audit([
            release('v12.156.0', SETTLED, [SBOM_ASSET]),
            release('v10.5.2', '2026-10-09T18:00:00Z', []),
            release('v9.0.0', '2026-08-01T00:00:00Z', []),
        ]);
        expect(r.status).toBe(0);
        expect(r.out).toContain('audited=1');
        expect(r.out).toContain('skipped_before_floor=2');
    });

    it('puts the floor exactly ON the oldest release that HAS one, not above it', () => {
        // Off by one in the other direction would exclude the release whose
        // existence is the floor's own evidence.
        const r = audit([release('v10.5.3', FLOOR_ISO, [SBOM_ASSET])]);
        expect(r.status).toBe(0);
        expect(r.out).toContain('verdict=clean');
        expect(r.out).toContain('audited=1');
    });
});

describe('the edges that would shrink the population silently', () => {
    it('AUDITS a release whose publication date is unparseable', () => {
        // Skipping it would let one malformed row remove a release from the
        // denominator with nothing saying so — the failure this whole file
        // exists to prevent, one level further in.
        const r = audit([{ tag_name: 'v12.0.0', published_at: 'not-a-date', assets: [] }]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('MISSING v12.0.0');
        expect(r.out).toContain('audited=1');
    });

    it('treats a release with OTHER assets but no SBOM as missing', () => {
        // `assets.length > 0` is the tempting check and it is wrong: a release
        // carrying a changelog or a binary and no SBOM is exactly the state
        // this audits for.
        const r = audit([release('v12.0.0', SETTLED, ['notes.md', 'app.tar.gz'])]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('MISSING v12.0.0');
    });

    it('survives a release row with no assets key at all', () => {
        const r = audit([{ tag_name: 'v12.0.0', published_at: SETTLED }]);
        expect(r.status).not.toBe(0);
        expect(r.out).toContain('MISSING v12.0.0');
    });

    it('bounds the window, so an older release outside it is neither audited nor reported', () => {
        const rows = Array.from({ length: 5 }, (_, i) =>
            release(`v12.0.${i}`, SETTLED, i < 2 ? [SBOM_ASSET] : []));
        const r = audit(rows, ['--window', '2']);
        expect(r.status).toBe(0);
        expect(r.out).toContain('audited=2');
    });
});

describe('the reading', () => {
    it('tags EVERY line, so the step-summary reporter collects all of it', () => {
        // `denominator-summary.cjs` collects PER LINE, so an untagged
        // continuation is dropped and the reading arrives truncated.
        const r = audit([
            release('v12.151.2', SETTLED, []),
            release('v12.151.3', SETTLED, []),
        ]);
        const tagged = r.out.split('\n').filter((l) => l.startsWith('[sbom-presence]'));
        expect(tagged).toHaveLength(3);
        expect(tagged[0]).toContain('verdict=missing');
        expect(tagged[0]).toContain('audited=2');
    });
});

#!/usr/bin/env node
/**
 * Which published releases are MISSING their SBOM — #2884.
 *
 * ## Why this exists when `Attach SBOM` already fails loud
 *
 * It does fail loud, and that is not the gap. `release.yml`'s `Attach SBOM`
 * step reports the actionable property — "this release has no SBOM" — and
 * `ci-failure-issue.yml` turns the red run into an issue. Both worked. Four
 * times on 2026-11-08 (`v12.151.2`, `v12.151.3`, `v12.151.5`, `v12.152.0`).
 *
 * What failed is that **the signal did not survive its own success.** The
 * notifier closes its issue on the next green run of the same workflow, which
 * is right for a flaky check and wrong here: the next Release succeeding says
 * nothing whatever about the previous release's SBOM. So four issues opened
 * and all four self-closed, and afterwards the repository said nothing — no
 * open issue, no list of affected tags, and the repair command (which the
 * error does print) surviving only inside a closed issue's log.
 *
 * `sbom-backfill.yml` had already run twice by hand before that, so the
 * pattern had been invisible at least twice.
 *
 * ## Why a state question is self-closing-SAFE, which the issue did not say
 *
 * #2884 proposed either taking this out of the self-closing family or writing
 * a state-based audit, as two options. They are not alternatives: a state
 * audit makes the family rule CORRECT rather than needing an exemption.
 *
 * "Did the last run succeed" and "does any release lack an SBOM" are different
 * questions, and only the second one's green answer is a true statement about
 * the durable artefact. A green audit means no release in the window is
 * missing its file — which is exactly what closing the issue should assert.
 * So this joins `ci-failure-issue.yml`'s watchlist like every other probe, and
 * needs no special case.
 *
 * Same shape as `Image tip check` and `Basemap Provenance`: assert the state
 * of the world, not the outcome of a run.
 *
 * ## A release published SECONDS ago legitimately has no asset yet
 *
 * MEASURED while writing this, and it would have made the audit a false-alarm
 * generator: `v12.157.0` read back with an EMPTY asset list 1m40s after
 * publication, and carried its 2,526,346-byte `sbom.spdx.json` a minute later.
 * The release row is created by semantic-release and the asset is uploaded by
 * a later step, so there is a real window in which absence means "not yet".
 *
 * Hence `graceMs`. Without it the `workflow_run` trigger — which fires the
 * moment Release completes — would report nearly every release as missing one,
 * and a probe that cries wolf is one people learn to ignore, which is the same
 * ending as the silence it was written to fix.
 *
 * ## The floor is DERIVED, not a round number
 *
 * Releases predating the SBOM step legitimately carry no asset, so an audit
 * with no lower bound goes permanently red as its window slides back. Measured
 * 2026-11-09 over every release this repo has: the oldest carrying
 * `sbom.spdx.json` is **`v10.5.3`, published 2026-10-09T19:34:41Z**. Anything
 * older is out of scope by construction rather than by exemption.
 *
 * The window is bounded on BOTH ends for that reason — a count alone would
 * eventually reach back past the floor, and a date alone would audit hundreds
 * of releases on every run.
 *
 * ## An empty feed is UNKNOWN, never "all good"
 *
 * A listing that returns nothing — a token without `contents: read`, a renamed
 * repository, an API error swallowed upstream — produces zero missing releases,
 * which is byte-identical to a clean audit. `verdict: 'unaudited'` separates
 * them, and the caller treats it as a failure. This is the
 * `absence-reads-as-success` rule, and the reason the exit code is not simply
 * `missing.length > 0`.
 */

/** The oldest release carrying an SBOM; see the docblock for the measurement. */
export const SBOM_FLOOR_ISO = '2026-10-09T19:34:41Z';

/**
 * How recently published a release may be before its missing asset is treated
 * as "not yet" rather than "never". Fifteen minutes against an observed
 * attach latency of about a minute.
 */
export const ATTACH_GRACE_MS = 15 * 60 * 1000;

/** How many releases back to look. ~2-3 days at this repo's release rate. */
export const WINDOW = 40;

/** The asset `Attach SBOM` uploads. Spelled once. */
export const SBOM_ASSET = 'sbom.spdx.json';

/**
 * @typedef {object} ReleaseRow
 * @property {string} tag_name
 * @property {string} published_at
 * @property {{ name: string }[]} assets
 */

/**
 * @typedef {object} Verdict
 * @property {'clean' | 'missing' | 'unaudited'} verdict
 * @property {{ tag: string, publishedAt: string }[]} missing
 * @property {number} audited   how many releases were actually judged
 * @property {number} skippedTooNew
 * @property {number} skippedBeforeFloor
 * @property {string} summary
 */

/**
 * Judge a release listing.
 *
 * PURE, and takes the rows rather than fetching them, so the test can feed it
 * the three cases that matter — a missing asset, a present one, and an empty
 * feed — without a network or a stubbed `gh`.
 *
 * @param {ReleaseRow[]} releases  newest-first, as the GitHub API returns them
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.graceMs]
 * @param {string} [opts.floorIso]
 * @param {number} [opts.window]
 * @returns {Verdict}
 */
export function auditReleases(releases, opts = {}) {
    const nowMs = opts.nowMs ?? Date.now();
    const graceMs = opts.graceMs ?? ATTACH_GRACE_MS;
    const floorMs = Date.parse(opts.floorIso ?? SBOM_FLOOR_ISO);
    const window = opts.window ?? WINDOW;

    if (!Array.isArray(releases) || releases.length === 0) {
        return {
            verdict: 'unaudited',
            missing: [],
            audited: 0,
            skippedTooNew: 0,
            skippedBeforeFloor: 0,
            summary:
                'The release listing was EMPTY, so nothing was audited. This is not '
                + 'a clean result: a token without `contents: read`, a renamed '
                + 'repository or a swallowed API error all produce zero missing '
                + 'releases, which reads exactly like a pass.',
        };
    }

    /** @type {{ tag: string, publishedAt: string }[]} */
    const missing = [];
    let audited = 0;
    let skippedTooNew = 0;
    let skippedBeforeFloor = 0;

    for (const release of releases.slice(0, window)) {
        const publishedMs = Date.parse(release.published_at ?? '');
        // An unparseable date is AUDITED rather than skipped. Skipping would
        // let one malformed row remove a release from the population silently,
        // and the whole point of this file is that a shrinking population
        // reads as a pass.
        if (Number.isFinite(publishedMs)) {
            if (publishedMs < floorMs) {
                skippedBeforeFloor += 1;
                continue;
            }
            if (nowMs - publishedMs < graceMs) {
                skippedTooNew += 1;
                continue;
            }
        }
        audited += 1;
        const names = (release.assets ?? []).map((a) => a?.name);
        if (!names.includes(SBOM_ASSET)) {
            missing.push({ tag: release.tag_name, publishedAt: release.published_at });
        }
    }

    // Every release in the window was either too new or below the floor. That
    // is a legitimate state right after the floor moves, and it is still not a
    // pass — nothing was checked.
    if (audited === 0) {
        return {
            verdict: 'unaudited',
            missing: [],
            audited: 0,
            skippedTooNew,
            skippedBeforeFloor,
            summary:
                `No release was judged: ${skippedTooNew} published within the grace `
                + `window and ${skippedBeforeFloor} predate the SBOM step. Nothing `
                + 'was checked, which is not the same as nothing being wrong.',
        };
    }

    if (missing.length === 0) {
        return {
            verdict: 'clean',
            missing: [],
            audited,
            skippedTooNew,
            skippedBeforeFloor,
            summary:
                `All ${audited} audited release(s) carry ${SBOM_ASSET}. `
                + `(${skippedTooNew} too new to judge, ${skippedBeforeFloor} below the floor.)`,
        };
    }

    return {
        verdict: 'missing',
        missing,
        audited,
        skippedTooNew,
        skippedBeforeFloor,
        summary:
            `${missing.length} of ${audited} audited release(s) have NO ${SBOM_ASSET}: `
            + `${missing.map((m) => m.tag).join(', ')}. Repair each with `
            + '`gh workflow run sbom-backfill.yml -f tag=<TAG>`, then re-run this audit '
            + 'rather than assuming the repair worked.',
    };
}

/** `[tag]`-prefixed so `denominator-summary.cjs` collects it. */
export function formatReading(v) {
    const lines = [
        `[sbom-presence] verdict=${v.verdict} audited=${v.audited} missing=${v.missing.length}`
        + ` skipped_too_new=${v.skippedTooNew} skipped_before_floor=${v.skippedBeforeFloor}`,
    ];
    for (const m of v.missing) {
        lines.push(`[sbom-presence]   MISSING ${m.tag} (published ${m.publishedAt})`);
    }
    return lines.join('\n');
}

/**
 * Read the releases, from the API or — for the tests — from a file.
 *
 * `--from-file` exists so the suite can drive this through `spawnSync` with
 * crafted listings, which is the repo's convention for an `.mjs` checker and
 * is STRICTLY stronger than importing `auditReleases`: it covers the
 * verdict→EXIT CODE mapping as well, and that mapping is where
 * "`unaudited` reads as a pass" would actually bite. CI never reads the
 * verdict object; it reads the exit code.
 */
async function readReleases(fromFile) {
    if (fromFile) {
        const { readFileSync } = await import('node:fs');
        return JSON.parse(readFileSync(fromFile, 'utf8'));
    }
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) {
        console.error('GITHUB_REPOSITORY is not set.');
        process.exit(1);
    }
    const token = process.env.GITHUB_TOKEN;
    const res = await fetch(
        `https://api.github.com/repos/${repo}/releases?per_page=${WINDOW}`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
        },
    );
    if (!res.ok) {
        // A failed LISTING is reported as a failure, never folded into an
        // empty array — which `auditReleases` would call `unaudited` anyway,
        // but saying which it was costs nothing and saves a diagnosis.
        console.error(`Listing releases failed: HTTP ${res.status}`);
        process.exit(1);
    }
    return res.json();
}

function argOf(flag) {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
    const releases = await readReleases(argOf('--from-file'));
    const nowArg = argOf('--now');
    const windowArg = argOf('--window');
    const verdict = auditReleases(releases, {
        ...(nowArg ? { nowMs: Date.parse(nowArg) } : {}),
        ...(windowArg ? { window: Number(windowArg) } : {}),
    });
    console.log(formatReading(verdict));
    console.log(verdict.summary);

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(
            summaryPath,
            `### SBOM presence audit\n\n${verdict.summary}\n`,
        );
    }

    // `clean` is the ONLY passing verdict. `unaudited` fails on purpose: see
    // the docblock on why an empty feed must not read as a pass.
    process.exit(verdict.verdict === 'clean' ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await main();
}

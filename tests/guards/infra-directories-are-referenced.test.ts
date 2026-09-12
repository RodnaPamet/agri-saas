/**
 * A directory under `infra/` that nothing runs is either deployed by something
 * outside this repo, or it is not deployed (#856).
 *
 * ## Why this is a guard on the SHAPE, not on any one directory
 *
 * Three times in one week a directory of infrastructure was found that nothing
 * runs — and each time a DOCUMENT asserted it was live, and twice a TEST
 * required the document to keep saying so.
 *
 *   · `infra/helm/` — `docs/deployment.md` called Kubernetes "the primary
 *     production path"; `k8s-runbook-coverage.test.ts` required that exact
 *     heading, 12 assertions, all green. Removed in #840.
 *   · `infra/terraform/` + `terraform.yml` + `deploy.yml` —
 *     `docs/infrastructure.md` was its operator's manual, with day-1/day-2
 *     runbooks. `deploy.yml` had ZERO runs, ever. Removed in #848.
 *   · `infra/observability/` + `infra/alerts/` — still here. `docs/slos.md`
 *     rests a 4-hour RTO on "typically 15 minutes via PagerDuty", and
 *     CLAUDE.md records the measured truth: no uptime check, no alert, no
 *     pager, no rota. Detection today is a human noticing.
 *
 * Closing each named instance by hand does not converge — that is three rounds
 * of the same finding. The general form is what this file asserts: enumerate
 * the directories, ask whether anything EXECUTABLE references them, and make
 * the answer a written decision instead of an assumption.
 *
 * ## What counts as a reference, and what deliberately does not
 *
 * A reference means something that RUNS reaches the directory: a workflow, a
 * compose file, a Dockerfile, a script, application source.
 *
 * `docs/` does NOT count. A document claiming a directory is live is precisely
 * the failure mode above — counting it would make the guard agree with the
 * claim it exists to test.
 *
 * `tests/` does NOT count either, and that exclusion is the sharper half. The
 * whole point of #856 is that a test asserting dead infrastructure's SHAPE is
 * a ratchet holding a false claim in place, not evidence the thing is used.
 * `oi-3-alerting.test.ts` asserts today that `infra/alerts/receivers.yml` has
 * "both PagerDuty (critical) and Slack (warning) tiers" and that "production
 * has a critical→pagerduty path", against an Alertmanager that does not exist.
 * If test references counted, every directory here would pass BECAUSE of the
 * ratchets that are the problem.
 *
 * ## The two controls
 *
 * A reference search can fail in two directions and only one of them is safe.
 * Finding nothing marks everything unreferenced and fails loudly. Matching too
 * eagerly marks everything referenced and passes over the whole population —
 * an empty selection wearing a different hat. So both directions are pinned:
 * a directory known to be referenced must come back REFERENCED, and a name
 * that appears nowhere must come back UNREFERENCED.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const INFRA = path.join(ROOT, 'infra');

/**
 * Where a reference has to appear to mean "something runs this". Deliberately
 * excludes `docs/` and `tests/` — see the docblock.
 */
const EXECUTABLE_SURFACES = [
    '.github',
    'deploy',
    'scripts',
    'src',
    'prisma',
    'package.json',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.prod.yml',
    'docker-compose.staging.yml',
    'docker-compose.test.yml',
];

/**
 * Directories that nothing in this repo runs, each with the decision that was
 * made about it. Two answers are legitimate — "deployed from elsewhere" and
 * "not deployed" — and an entry must say WHICH, because they have opposite
 * consequences for an operator reading the docs.
 *
 * This list may only SHRINK. Deleting a directory, or wiring one up, means
 * deleting its entry in the same PR.
 */
const NOT_RUN_FROM_THIS_REPO: Record<string, string> = {
    alerts:
        'NOT DEPLOYED. Alertmanager rules + receivers for a stack that does not exist — ' +
        'no Alertmanager, no PagerDuty integration, no key, no rota (CLAUDE.md, verified ' +
        '2026-09-10). `oi-3-alerting.test.ts` asserts its shape, which is the #856 ratchet, ' +
        'not evidence of use.',
    dashboards:
        'NOT DEPLOYED. Grafana dashboard JSON with no Grafana. `oi-3-observability.test.ts` ' +
        'asserts they "parse as Grafana JSON v8+" and carry UIDs so they are "importable + ' +
        'provisionable" — true of the files, and nothing imports or provisions them.',
    observability:
        'NOT DEPLOYED. A complete compose stack (grafana, otel-collector, prometheus, tempo) ' +
        'that no workflow, compose file or script references. OTel export is separately OFF: ' +
        '`instrumentation.ts` gates the initialiser on OTEL_ENABLED === "true" and no OTEL_* ' +
        'key exists in `deploy/env.prod.example`, so nothing is exporting to a dead port.',
    'otel-collector':
        'NOT DEPLOYED. Collector config belonging to the `observability` stack above.',
};

/** Top-level directories under `infra/`, from git rather than a hand-kept list. */
function infraDirectories(): string[] {
    return fs
        .readdirSync(INFRA, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
}

/**
 * Does anything executable reference `infra/<name>`?
 *
 * `git grep` rather than a filesystem walk: it respects `.gitignore`, so a
 * stray build artefact or a local scratch file can never look like a wiring.
 */
function referencedBy(name: string): string[] {
    const surfaces = EXECUTABLE_SURFACES.filter((s) => fs.existsSync(path.join(ROOT, s)));
    try {
        const out = execFileSync(
            'git',
            ['grep', '-l', '--fixed-strings', `infra/${name}`, '--', ...surfaces],
            { cwd: ROOT, encoding: 'utf-8' },
        );
        return out.split('\n').filter(Boolean);
    } catch {
        // `git grep` exits 1 on no matches. That is the answer, not an error.
        return [];
    }
}

describe('the reference search can tell the difference (controls)', () => {
    // Without these, every assertion below could be passing for the wrong
    // reason — a search that finds nothing, or one that matches everything.
    it('POSITIVE: a directory that IS wired up comes back referenced', () => {
        // `infra/scripts/restore-test-gcp.sh` is invoked by
        // `.github/workflows/restore-test.yml`.
        expect(referencedBy('scripts').length).toBeGreaterThan(0);
    });

    it('NEGATIVE: a name that appears nowhere comes back unreferenced', () => {
        expect(referencedBy('no-such-infra-directory-xyz')).toEqual([]);
    });

    it('the enumeration finds directories at all', () => {
        // An empty selection satisfies every per-directory assertion below.
        expect(infraDirectories().length).toBeGreaterThanOrEqual(3);
    });
});

describe('every infra/ directory is either run from this repo or recorded as not', () => {
    it('no directory is silently unreferenced', () => {
        const undecided = infraDirectories().filter(
            (name) => referencedBy(name).length === 0 && !(name in NOT_RUN_FROM_THIS_REPO),
        );

        if (undecided.length > 0) {
            throw new Error(
                [
                    `Nothing that runs references: ${undecided.join(', ')}`,
                    ``,
                    `A directory under infra/ that no workflow, compose file, script or`,
                    `source file reaches is either deployed by something outside this repo,`,
                    `or it is not deployed. Both are worth knowing; the second is worth`,
                    `deleting.`,
                    ``,
                    `Decide, then either wire it up, delete it, or add it to`,
                    `NOT_RUN_FROM_THIS_REPO in this file with a reason saying WHICH of the`,
                    `two it is. Do not count a doc or a test as the answer — a document`,
                    `asserting it is live, and a test pinning its shape, are exactly what`,
                    `#856 is about.`,
                ].join('\n'),
            );
        }
        expect(undecided).toEqual([]);
    });

    it('every recorded directory still exists and is still unreferenced', () => {
        const dirs = new Set(infraDirectories());
        const stale = Object.keys(NOT_RUN_FROM_THIS_REPO).filter(
            (name) => !dirs.has(name) || referencedBy(name).length > 0,
        );

        if (stale.length > 0) {
            throw new Error(
                [
                    `These entries no longer describe the tree: ${stale.join(', ')}`,
                    ``,
                    `Each was either deleted or wired up. Remove its entry from`,
                    `NOT_RUN_FROM_THIS_REPO in the same PR — the list may only shrink, or`,
                    `it stops being a record of decisions and becomes a place things hide.`,
                ].join('\n'),
            );
        }
        expect(stale).toEqual([]);
    });

    it('every entry states which of the two answers it is', () => {
        // "Not deployed" and "deployed from elsewhere" have opposite
        // consequences for an operator reading the runbook. An entry that says
        // neither is a note, not a decision.
        const vague = Object.entries(NOT_RUN_FROM_THIS_REPO)
            .filter(([, reason]) => !/NOT DEPLOYED|DEPLOYED FROM/i.test(reason))
            .map(([name]) => name);
        expect(vague).toEqual([]);
    });
});

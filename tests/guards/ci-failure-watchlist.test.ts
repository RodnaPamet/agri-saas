/**
 * The CI-failure notifier's watch list is DERIVED, not curated.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `ci-failure-issue.yml` names the workflows it watches in a hand-written
 * list. A hand-written list is a list somebody forgets, and somebody did:
 * `Publish image to GHCR` — the one workflow that produces the artifact
 * production actually runs — was missing from it. So when that workflow's
 * build exceeded its 20-minute budget on 2026-09-08 (run 34208631386) and
 * GitHub reported the run as `cancelled`, NOTHING was filed. Answering the
 * resulting question — "did the image ship?" — took a manual read of 1630
 * lines of buildx output, because a cancelled publish and a healthy
 * superseded publish look identical from the run list. Three other
 * workflows were missing for the same reason (#805).
 *
 * The rule below is mechanical, so the next workflow added to this repo is
 * watched by default rather than by remembering. That is the whole point:
 * the failure mode was not "somebody chose wrongly", it was "somebody had
 * to choose at all".
 *
 * This is a static guard — it reads source text and asserts on it. It proves
 * the LIST is right. It does not prove the notifier behaves correctly; that
 * is `tests/unit/ci-failure-notifier.test.ts`, which executes the script.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const WORKFLOW_DIR = path.resolve(__dirname, '../../.github/workflows');
const NOTIFIER = 'ci-failure-issue.yml';

/**
 * Triggers that make a red run LOUD on their own, so a workflow reachable
 * ONLY through them needs no issue filed:
 *
 *   · `pull_request`  — the run sits on a PR page somebody opened on purpose.
 *   · `merge_group`   — a red run blocks the merge queue, which is its own
 *                       unmissable signal.
 *
 * Every other trigger (`push`, `schedule`, `workflow_dispatch`,
 * `workflow_run`, `release`, …) can go red with nobody looking, which is the
 * class this notifier exists for.
 */
const LOUD_TRIGGERS = new Set(['pull_request', 'merge_group']);

interface Workflow {
    file: string;
    name: string;
    triggers: string[];
}

function readWorkflows(): Workflow[] {
    return fs
        .readdirSync(WORKFLOW_DIR)
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((file) => {
            const doc = yaml.load(
                fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'),
            ) as Record<string, unknown>;

            // js-yaml 4 follows the YAML 1.2 core schema, where the bare key
            // `on` stays the STRING "on". Under YAML 1.1 it would have been
            // parsed as the boolean `true` and every lookup here would
            // silently miss — an assertion that cannot fail is worse than no
            // assertion, so this is checked rather than assumed.
            expect(Object.keys(doc)).toContain('on');

            const on = doc.on as Record<string, unknown> | string | string[];
            const triggers =
                typeof on === 'string'
                    ? [on]
                    : Array.isArray(on)
                      ? on
                      : Object.keys(on ?? {});

            return { file, name: String(doc.name ?? ''), triggers };
        });
}

/** Every workflow this notifier is expected to watch, derived from the files. */
function expectedWatchList(workflows: Workflow[]): string[] {
    return workflows
        .filter((w) => w.file !== NOTIFIER) // it cannot report its own failure
        .filter((w) => !w.triggers.every((t) => LOUD_TRIGGERS.has(t)))
        .map((w) => w.name)
        .sort();
}

function actualWatchList(): string[] {
    const doc = yaml.load(
        fs.readFileSync(path.join(WORKFLOW_DIR, NOTIFIER), 'utf8'),
    ) as Record<string, { workflow_run?: { workflows?: string[] } }>;
    return [...(doc.on.workflow_run?.workflows ?? [])].sort();
}

describe('CI-failure notifier — the watch list is derived, not curated', () => {
    it('watches every workflow that can fail silently', () => {
        const workflows = readWorkflows();
        const expected = expectedWatchList(workflows);
        const actual = actualWatchList();

        // Named individually so a drift reports WHICH workflow is unwatched
        // rather than dumping two sorted arrays at the reader.
        const unwatched = expected.filter((n) => !actual.includes(n));
        expect(unwatched).toEqual([]);

        // The reverse direction matters too: an entry naming a workflow that
        // no longer exists is dead weight that reads as coverage.
        const phantom = actual.filter((n) => !expected.includes(n));
        expect(phantom).toEqual([]);
    });

    it('every watched name matches a real workflow `name:`', () => {
        // `workflow_run` matches on the workflow's `name`, not its filename,
        // so a typo here fails OPEN — the notifier simply never triggers, and
        // nothing anywhere reports that it did not.
        const names = readWorkflows().map((w) => w.name);
        for (const watched of actualWatchList()) {
            expect(names).toContain(watched);
        }
    });

    it('excludes only this workflow itself', () => {
        const workflows = readWorkflows();
        const excluded = workflows
            .filter((w) => !actualWatchList().includes(w.name))
            .map((w) => w.file);

        // If this ever grows, the reason belongs in the YAML comment next to
        // the list AND here — not in a commit message nobody re-reads.
        expect(excluded).toEqual([NOTIFIER]);
    });

    it('the rule is non-vacuous: it would catch a newly added workflow', () => {
        // A positive control. If `expectedWatchList` returned [] — because the
        // directory moved, the parse silently failed, or `on` became `true` —
        // the first test would pass while proving nothing. This asserts the
        // derivation actually produced a non-trivial set that includes the
        // workflow #805 was filed about.
        const expected = expectedWatchList(readWorkflows());
        expect(expected.length).toBeGreaterThan(5);
        expect(expected).toContain('Publish image to GHCR');
    });
});

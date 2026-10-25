/**
 * Every workflow that authenticates to GCP declares `id-token: write`.
 *
 * ## The failure, measured
 *
 * `backup-exists.yml` used `google-github-actions/auth` with
 * `permissions: {contents: read, issues: write}`. Its first CI run
 * (40182294948) died with:
 *
 *     gitHub Actions did not inject $ACTIONS_ID_TOKEN_REQUEST_TOKEN or
 *     $ACTIONS_ID_TOKEN_REQUEST_URL into this job. This most likely means the
 *     GitHub Actions workflow permissions are incorrect, or this job is being
 *     run from a fork.
 *
 * — a message that names neither the missing permission nor the file, and
 * offers "or run from a fork" as an equally likely cause. The workflow's own
 * preflight, whose stated purpose is to fail with a NAMED diagnosis rather
 * than dying inside the auth action, passed: it checked that the two secrets
 * were set, which says nothing about whether a token can be minted from them.
 *
 * ## Why a guard rather than just the fix
 *
 * The assertion already existed — `expect(wf.permissions['id-token'])
 * .toBe('write')` in `oi-3-backup-restore.test.ts` — and was correct, over a
 * population of exactly one file. The second workflow to use the mechanism was
 * outside its reach, and nothing failed when it arrived.
 *
 * So the population here is DERIVED: whichever workflows use the auth action.
 * A hand-listed set would reproduce the original defect, which is not that
 * somebody wrote the wrong permission but that the rule knew about one file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { collectTrackedFiles } from '../helpers/collect-files';

const AUTH_ACTION = /google-github-actions\/auth@v[0-9]/;

interface Wf {
    file: string;
    permissions: Record<string, string> | string | undefined;
    jobPermissions: Record<string, Record<string, string> | string | undefined>;
    src: string;
}

/**
 * `collectTrackedFiles` rather than a hand-rolled `readdirSync`, for the reason
 * `file-collection-is-not-silently-empty` enforces: a hand-rolled collector can
 * be gutted to `return []` with every assertion built on it still green — 81%
 * of the guards an automated sweep could audit were dead that way. The shared
 * helper refuses an empty result.
 *
 * `git ls-files` is also the better question here: an untracked scratch
 * workflow in somebody's checkout is not something this rule should grade.
 */
function wifWorkflows(): Wf[] {
    return collectTrackedFiles({
        roots: ['.github/workflows'],
        extensions: ['.yml', '.yaml'],
    })
        // Already ABSOLUTE — the helper returns `path.join(REPO_ROOT, rel)`.
        // Joining REPO_ROOT again produced a doubled path and the suite failed
        // to RUN, which prints `Tests: 0 total` rather than a failing
        // assertion: a guard that cannot load is not a guard that passes.
        .map((abs) => ({ f: path.basename(abs), src: fs.readFileSync(abs, 'utf8') }))
        .filter(({ src }) => AUTH_ACTION.test(src))
        .map(({ f, src }) => {
            const doc = yaml.load(src) as {
                permissions?: Record<string, string> | string;
                jobs?: Record<string, { permissions?: Record<string, string> | string }>;
            };
            const jobPermissions: Wf['jobPermissions'] = {};
            for (const [name, job] of Object.entries(doc.jobs ?? {})) {
                jobPermissions[name] = job?.permissions;
            }
            return { file: f, permissions: doc.permissions, jobPermissions, src };
        });
}

const WFS = wifWorkflows();

/**
 * Job-level `permissions:` REPLACES the workflow-level block rather than
 * merging with it, so a job that narrows permissions can drop `id-token` while
 * the top of the file still grants it. Either level may carry it; what must
 * not happen is a job whose effective permissions lack it.
 */
function grantsIdToken(level: Record<string, string> | string | undefined): boolean {
    if (typeof level !== 'object' || level === null) return false;
    return level['id-token'] === 'write';
}

describe('workflows that authenticate to GCP declare id-token: write', () => {
    it('[wif-id-token] ranges over a derived, non-empty set', () => {
        console.log(
            `[wif-id-token] ${WFS.length} workflow(s) use google-github-actions/auth: `
                + WFS.map((w) => w.file).join(', '),
        );
        // A regex that stopped matching would make every assertion below pass
        // over nothing — and the defect this guards against is silent, so an
        // empty population is the same bug one level up.
        expect(WFS.length).toBeGreaterThanOrEqual(2);
    });

    it.each(WFS.map((w) => [w.file, w] as const))(
        '%s grants id-token: write',
        (_file, wf) => {
            const atTop = grantsIdToken(wf.permissions);
            // Every job must END UP with it. A job-level block replaces the
            // workflow-level one, so inheriting is only safe where the job
            // declares no permissions of its own.
            const jobsLacking = Object.entries(wf.jobPermissions)
                .filter(([, p]) => (p === undefined ? !atTop : !grantsIdToken(p)))
                .map(([name]) => name);
            expect({ file: wf.file, jobsWithoutIdToken: jobsLacking })
                .toEqual({ file: wf.file, jobsWithoutIdToken: [] });
        },
    );

    it.each(WFS.map((w) => [w.file, w] as const))(
        '%s uses WIF, not a long-lived JSON key',
        (_file, wf) => {
            // This repository is PUBLIC. `credentials_json` would mean a
            // long-lived service-account key in a repository secret, which
            // WIF exists specifically to avoid.
            expect({ file: wf.file, usesJsonKey: /credentials_json/.test(wf.src) })
                .toEqual({ file: wf.file, usesJsonKey: false });
        },
    );

    it('the rule is non-vacuous: it would catch a workflow that omitted the permission', () => {
        // The assertion it replaces was correct and covered one file, so the
        // thing worth proving is that this one reacts to the shape rather than
        // to a known filename.
        expect(grantsIdToken({ 'contents': 'read', 'issues': 'write' })).toBe(false);
        expect(grantsIdToken({ 'contents': 'read', 'id-token': 'write' })).toBe(true);
        expect(grantsIdToken({ 'id-token': 'read' })).toBe(false);
        expect(grantsIdToken('read-all')).toBe(false);
        expect(grantsIdToken(undefined)).toBe(false);
    });
});

/**
 * Staging-smoke-gate ratchet.
 *
 * `.github/workflows/deploy.yml` promotes a `production` target in
 * ONE run: deploy-staging → smoke-staging → deploy-production →
 * smoke-production. Production is STRUCTURALLY GATED — the
 * `deploy-production` job declares `needs: [smoke-staging]`, and
 * GitHub Actions never starts a job whose `needs` dependency
 * failed. So production cannot deploy unless the exact same image
 * first passed staging deploy + staging smoke.
 *
 * This test fails CI if that gate is ever weakened:
 *   - `smoke-staging` removed from `deploy-production`'s `needs`
 *   - the `smoke-staging` or `deploy-staging` job deleted
 *   - the staging→production job chain broken
 *   - `deploy-production` losing its `environment: production`
 *     (the human-approval half of the gate)
 *
 * A guardrail on a release-governance practice: it is not a test of
 * the deploy itself (that needs a live cluster) but a lock on the
 * workflow's STRUCTURE, which is where the gate lives.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const DEPLOY_YML = path.join(ROOT, '.github/workflows/deploy.yml');
const HELM_ACTION = path.join(ROOT, '.github/actions/helm-deploy/action.yml');

/** Split a workflow's `jobs:` map into { jobName -> raw block text }. */
function parseJobs(yaml: string): Map<string, string> {
    const lines = yaml.split('\n');
    const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    const jobs = new Map<string, string>();
    if (jobsIdx < 0) return jobs;
    let current: string | null = null;
    let buf: string[] = [];
    for (let i = jobsIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        const header = line.match(/^ {2}([A-Za-z][\w-]*):\s*$/);
        if (header) {
            if (current) jobs.set(current, buf.join('\n'));
            current = header[1];
            buf = [line];
        } else if (/^[A-Za-z]/.test(line)) {
            break; // a new 0-indent top-level key — jobs section ended
        } else if (current) {
            buf.push(line);
        }
    }
    if (current) jobs.set(current, buf.join('\n'));
    return jobs;
}

/** Extract the `needs:` job list from a job block (inline array, single, or block list). */
function needsOf(block: string): string[] {
    const inline = block.match(/^\s*needs:\s*\[([^\]]*)\]/m);
    if (inline) {
        return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
    const single = block.match(/^\s*needs:\s*([A-Za-z][\w-]*)\s*$/m);
    if (single) return [single[1]];
    const blockList = block.match(/^\s*needs:\s*\n((?:\s*-\s*[\w-]+\s*\n?)+)/m);
    if (blockList) {
        return blockList[1]
            .split('\n')
            .map((l) => l.replace(/^\s*-\s*/, '').trim())
            .filter(Boolean);
    }
    return [];
}

const yaml = fs.readFileSync(DEPLOY_YML, 'utf8');
const jobs = parseJobs(yaml);

describe('deploy.yml — staging smoke gate', () => {
    it('the three gate jobs all exist', () => {
        expect(jobs.has('deploy-staging')).toBe(true);
        expect(jobs.has('smoke-staging')).toBe(true);
        expect(jobs.has('deploy-production')).toBe(true);
    });

    it('production deploy is gated: deploy-production needs smoke-staging', () => {
        const needs = needsOf(jobs.get('deploy-production') ?? '');
        // THE gate. Remove this edge and production can deploy without
        // a proven staging validation — exactly the regression this
        // ratchet exists to catch.
        expect(needs).toContain('smoke-staging');
    });

    it('staging smoke runs after staging deploy', () => {
        const needs = needsOf(jobs.get('smoke-staging') ?? '');
        expect(needs).toContain('deploy-staging');
    });

    it('the full chain deploy-staging → smoke-staging → deploy-production holds', () => {
        // Transitive proof: production cannot run until staging was
        // deployed AND smoke-tested.
        expect(needsOf(jobs.get('smoke-staging') ?? '')).toContain(
            'deploy-staging',
        );
        expect(needsOf(jobs.get('deploy-production') ?? '')).toContain(
            'smoke-staging',
        );
    });

    it('deploy-production carries the production GitHub Environment (human-approval gate)', () => {
        const block = jobs.get('deploy-production') ?? '';
        expect(block).toMatch(/^\s*environment:\s*production\s*$/m);
    });

    it('deploy-production only runs for a production target', () => {
        const block = jobs.get('deploy-production') ?? '';
        const ifLine = block.match(/^\s*if:\s*(.+)$/m);
        expect(ifLine).not.toBeNull();
        expect(ifLine?.[1]).toContain('production');
    });

    it('smoke-staging actually executes a smoke check', () => {
        const block = jobs.get('smoke-staging') ?? '';
        expect(block).toMatch(/scripts\/smoke-\w+\.mjs/);
    });

    it('the shared helm-deploy composite action exists', () => {
        expect(fs.existsSync(HELM_ACTION)).toBe(true);
    });

    // ── Regression proof — the detector catches a removed gate ──
    it('detects a deploy-production that drops the smoke-staging edge', () => {
        const block = jobs.get('deploy-production') ?? '';
        const sabotaged = block.replace(
            /needs:\s*\[[^\]]*\]/,
            'needs: [gate, build-image]',
        );
        expect(needsOf(sabotaged)).not.toContain('smoke-staging');
    });
});

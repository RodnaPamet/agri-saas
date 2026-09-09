import * as fs from 'fs';
import * as path from 'path';

/**
 * `docs/deployment.md` must name the path production ACTUALLY uses.
 *
 * This replaces the GAP-12 step-10 ratchet (`k8s-runbook-coverage.test.ts`),
 * deleted in #808. That ratchet asserted the doc "marks the Kubernetes/EKS
 * path as the primary production model", and its own comment explained why
 * the framing mattered: "SRE on-call triages production by what this header
 * says."
 *
 * It was right about the stakes and wrong about the fact. The EKS path never
 * ran a single time; production is, and has only ever been, docker compose on
 * a GCP VM. So the ratchet was holding an incident runbook in place that
 * pointed at RDS snapshots, S3 versioning and `helm rollback` against
 * infrastructure that was never provisioned — the worst possible thing for an
 * on-call engineer to be reading at 3am, and a test was keeping it there.
 *
 * The lesson is not "delete the ratchet". A ratchet on this header is a good
 * idea for exactly the reason the original gave. It just has to point at what
 * is true, and it has to be able to fail when the doc drifts back.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const DOC = 'docs/deployment.md';

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('deployment.md names the real production path', () => {
    it('the doc is substantial — a truncated file must fail, not pass vacuously', () => {
        // Positive control. Every assertion below is a `not.toMatch` or a
        // presence check against one file; an empty or missing-section file
        // would satisfy the negative ones silently.
        const src = readRepoFile(DOC);
        expect(src.split('\n').length).toBeGreaterThan(500);
        expect(src).toMatch(/^# Deployment Guide/m);
    });

    it('does NOT frame Kubernetes/EKS as the primary production path', () => {
        const src = readRepoFile(DOC);
        // The exact header the old ratchet REQUIRED. It is false: deploy.yml
        // never ran, and it was deleted in #808 with the Terraform layer.
        expect(src).not.toMatch(/Kubernetes \(Helm\) — primary production path/);
    });

    it('does NOT call the compose path deprecated or secondary', () => {
        const src = readRepoFile(DOC);
        // The other half of the same falsehood: the doc used to call the
        // compose path "deprecated as the primary production model". It is
        // the only path that has ever run.
        expect(src).not.toMatch(/deprecated as the primary production model/);
    });

    it('names deploy/apply.sh and the VM compose file as the production path', () => {
        const src = readRepoFile(DOC);
        expect(src).toMatch(/deploy\/apply\.sh/);
        expect(src).toMatch(/deploy\/docker-compose\.vm\.yml/);
    });

    it('says plainly that the Helm chart is not a deployed path', () => {
        const src = readRepoFile(DOC);
        // The chart is still in the tree (infra/helm). Someone will find it
        // and assume it ships. The doc has to say otherwise.
        expect(src).toMatch(/NOT the production path|not a supported path|unused and undeployed/i);
    });
});

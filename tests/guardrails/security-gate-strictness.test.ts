/**
 * GAP-05 — Structural ratchet for CI security gate strictness.
 * (Tightened 2026-05-12: high+ → moderate+.)
 *
 * The audit's GAP-05 finding noted that npm audit and Trivy gates
 * had been lowered (high → critical, CRITICAL,HIGH → CRITICAL) as a
 * temporary workaround to unblock CI while the Next.js 14 line
 * carried unfixable HIGH advisories. The Next 14 → 15.5 migration
 * cleared those advisories; the migration commit restored both gates
 * to their original strictness.
 *
 * 2026-05-12 the npm-audit gate was raised one further notch from
 * `--audit-level=high` to `--audit-level=moderate`. Moderate-severity
 * CVEs in production deps (postcss XSS, hono middleware bypass,
 * protobufjs decoding bugs) are the exact failure mode this gate
 * exists to prevent.
 *
 * This guardrail asserts the gates STAY restored AND ratchets only
 * in the strictness direction:
 *
 *   • npm audit production-deps gate is `moderate` OR `low` (or
 *     `info` — anything tighter than `high`). The regression class
 *     this catches: a future PR dropping back to `high`, `critical`,
 *     or removing the gate entirely.
 *
 *   • Trivy gate declares CRITICAL,HIGH (or tighter). A future PR
 *     that downgrades to `CRITICAL` alone reintroduces the
 *     lowered-gate posture GAP-05 closed.
 *
 * A written rationale + an upgrade plan tied to a specific advisory
 * must accompany any future lowering, NOT a workaround.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function readRepoFile(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('GAP-05 ratchet — CI security gate strictness', () => {
    const ci = readRepoFile('.github/workflows/ci.yml');

    it('npm audit gate blocks on MODERATE+ severity (production deps)', () => {
        // The canonical line — 2026-05-12 tightened from high → moderate.
        // The ratchet accepts any tighter level (`moderate`, `low`,
        // `info`) so future strictness bumps don't need a ratchet
        // diff to land. It REJECTS anything looser (`high`,
        // `critical`) — those are the regression classes this guard
        // exists to catch.
        const gateMatch = ci.match(
            /npm audit --omit=dev --audit-level=(moderate|low|info)/,
        );
        expect(gateMatch).not.toBeNull();
        // Regression: pre-2026-05-12 the gate was `high`; pre-GAP-05
        // it was `critical`. A future PR that drops back to either
        // without a written rationale is the change this guard catches.
        // Note: the all-deps informational scan (without `--omit=dev`)
        // legitimately stays at `critical` to limit noise from
        // dev-only packages — it is not an audit-blocker.
        expect(ci).not.toMatch(/npm audit --omit=dev --audit-level=high\b/);
        expect(ci).not.toMatch(/npm audit --omit=dev --audit-level=critical\b/);
    });

    it('Trivy scan gate blocks on CRITICAL,HIGH, not CRITICAL-only', () => {
        // The Trivy gate must declare both severities. Match the
        // YAML key on its own line so the SARIF-upload step (which
        // legitimately scans all severities) doesn't accidentally
        // pass this assertion.
        expect(ci).toMatch(/severity:\s*["']CRITICAL,HIGH["']/);
        // Regression: a future PR that downgrades to severity:
        // "CRITICAL" alone reintroduces the lowered-gate posture
        // GAP-05 closed.
        // We allow `severity: "CRITICAL,HIGH,MEDIUM"` (the SARIF
        // upload uses this) but NOT `severity: "CRITICAL"` alone.
        const lines = ci.split('\n');
        const blockingGate = lines.find(
            l => l.match(/severity:/) && l.match(/\bCRITICAL\b/) && !l.match(/HIGH/),
        );
        expect(blockingGate).toBeUndefined();
    });

    it('removed the documentation comment that explained the temporary lowering', () => {
        // The pre-migration ci.yml carried explicit comments naming
        // the lowering as temporary "until Next upgrade lands". Those
        // comments are now factually incorrect — the migration landed.
        // Regression: re-introducing the comment is the precursor to
        // re-introducing the lower gate.
        expect(ci).not.toMatch(/Lowered gate from CRITICAL,HIGH/);
        expect(ci).not.toMatch(/Gate was lowered from high → critical/);
    });
});

describe('GAP-05 ratchet — Next.js version pin', () => {
    it('package.json pins next to a 15.x or higher stable, no caret, no beta', () => {
        const pkg = JSON.parse(readRepoFile('package.json')) as {
            dependencies?: Record<string, string>;
        };
        const version = pkg.dependencies?.['next'];
        expect(version).toBeDefined();
        // Regression: the pre-migration pin was `^14.2.0` which auto-
        // resolved to `14.2.35`. The Next 14 line carries unfixable
        // HIGH advisories that GAP-05 closed by moving to 15.5.x.
        expect(version).not.toMatch(/^[\^~]?14\./);
        // Must be 15.x or higher; reject any beta / rc / canary suffix.
        expect(version).toMatch(/^(15|16|17|18)\.\d+\.\d+$/);
        expect(version).not.toMatch(/beta|alpha|rc|next|canary/i);
        // Pin shape: no caret/tilde — silent drift blocked by lockfile.
        expect(version).not.toMatch(/^[\^~]/);
    });

    // ── #826: the ratchet must follow the gate ──
    // A second Trivy gate now runs in `ghcr-publish.yml`, against the image
    // that actually ships. Before this test it would have been unratcheted
    // from birth: a later PR could quiet it to CRITICAL-only and nothing
    // would object, leaving the SHIPPED artifact scanned more loosely than
    // the discarded CI twin. A scan the guard does not read is a scan a
    // future PR can weaken.
    it('the SHIPPED image is scanned as strictly as the CI twin', () => {
        const publish = readRepoFile('.github/workflows/ghcr-publish.yml');

        // Positive control first: if this file ever stops running Trivy at
        // all, the severity assertions below would pass VACUOUSLY on an
        // empty match set — which is the failure mode this whole file is
        // about. Assert the gate is present before asserting its strictness.
        expect(publish).toMatch(/aquasecurity\/trivy-action/);
        expect(publish).toMatch(/severity:\s*["']CRITICAL,HIGH["']/);
        expect(publish).toMatch(/exit-code:\s*["']1["']/);

        const weakened = publish
            .split('\n')
            .find(l => l.match(/severity:/) && l.match(/\bCRITICAL\b/) && !l.match(/HIGH/));
        expect(weakened).toBeUndefined();
    });

    it('the publish gates run BEFORE the push, not after', () => {
        // Ordering is the whole guarantee. Gates that run after `docker push`
        // report on an artifact consumers can already pull, which is a
        // notification rather than a gate.
        const publish = readRepoFile('.github/workflows/ghcr-publish.yml');
        const gateAt = publish.indexOf('Gate: Trivy vulnerability scan');
        const pushAt = publish.indexOf('Push the gated image');
        expect(gateAt).toBeGreaterThan(-1);
        expect(pushAt).toBeGreaterThan(-1);
        expect(gateAt).toBeLessThan(pushAt);
    });
});

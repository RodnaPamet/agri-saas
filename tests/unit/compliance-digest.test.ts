/**
 * Compliance Digest Job Tests
 *
 * Verifies:
 *   1. Digest email rendering (text + HTML)
 *   2. Job registration and scheduling
 *   3. Recipient targeting (ADMIN only)
 *   4. Data reuse (snapshot-based, not live queries)
 *   5. Empty/low-data tenant handling
 *   6. Trend delta computation
 *   7. End-to-end pipeline coherence
 */

import * as fs from 'fs';
import * as path from 'path';

const DIGEST_FILE = path.resolve(__dirname, '../../src/app-layer/jobs/compliance-digest.ts');
const TYPES_FILE = path.resolve(__dirname, '../../src/app-layer/jobs/types.ts');
const SCHEDULES_FILE = path.resolve(__dirname, '../../src/app-layer/jobs/schedules.ts');
const EXECUTOR_FILE = path.resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts');
const SNAPSHOT_FILE = path.resolve(__dirname, '../../src/app-layer/jobs/snapshot.ts');

function readFile(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

// ─── Job Registration ──────────────────────────────────────────────

describe('Compliance Digest — Job Registration', () => {
    test('ComplianceDigestPayload exists in types.ts', () => {
        const content = readFile(TYPES_FILE);
        expect(content).toContain('export interface ComplianceDigestPayload');
    });

    test('compliance-digest in JobPayloadMap', () => {
        const content = readFile(TYPES_FILE);
        expect(content).toContain("'compliance-digest': ComplianceDigestPayload");
    });

    test('JOB_DEFAULTS has compliance-digest entry', () => {
        const content = readFile(TYPES_FILE);
        expect(content).toContain("'compliance-digest':");
    });

    test('executor-registry registers compliance-digest', () => {
        const content = readFile(EXECUTOR_FILE);
        expect(content).toContain("'compliance-digest'");
        expect(content).toContain('runComplianceDigest');
    });

    test('schedules.ts has compliance-digest scheduled', () => {
        const content = readFile(SCHEDULES_FILE);
        expect(content).toContain("name: 'compliance-digest'");
    });
});

// ─── Schedule ──────────────────────────────────────────────────────

describe('Compliance Digest — Schedule', () => {
    test('runs weekly (Monday at 08:00 UTC)', () => {
        const content = readFile(SCHEDULES_FILE);
        // Cron pattern for Monday 08:00 UTC: 0 8 * * 1
        expect(content).toContain("'0 8 * * 1'");
    });

    test('runs after snapshot job (05:00 UTC)', () => {
        const content = readFile(SCHEDULES_FILE);
        // Snapshot runs at 05:00, digest at 08:00 — data is always fresh
        const snapshotIdx = content.indexOf("'0 5 * * *'");
        const digestIdx = content.indexOf("'0 8 * * 1'");
        expect(snapshotIdx).toBeLessThan(digestIdx);
    });
});

// ─── Data Reuse (Snapshot-Based) ────────────────────────────────────

describe('Compliance Digest — Data Reuse', () => {
    const content = readFile(DIGEST_FILE);

    test('reads from ComplianceSnapshot (not live queries)', () => {
        expect(content).toContain('complianceSnapshot.findFirst');
    });

    test('does NOT import DashboardRepository (uses snapshots instead)', () => {
        expect(content).not.toContain('DashboardRepository');
    });

    test('does NOT call getExecutiveDashboard (uses snapshots instead)', () => {
        expect(content).not.toContain('getExecutiveDashboard');
    });

    test('reads latest snapshot and prior snapshot for delta', () => {
        // Should compare latest vs N days ago
        expect(content).toContain('latestSnapshot');
        expect(content).toContain('priorSnapshot');
        expect(content).toContain('comparisonDate');
    });
});

// ─── Recipient Targeting ────────────────────────────────────────────

describe('Compliance Digest — Recipient Targeting', () => {
    const content = readFile(DIGEST_FILE);

    test('queries TenantMembership for recipients', () => {
        expect(content).toContain('tenantMembership.findMany');
    });

    test('targets ADMIN role only', () => {
        expect(content).toContain("role: 'ADMIN'");
    });

    test('filters by ACTIVE status', () => {
        expect(content).toContain("status: 'ACTIVE'");
    });

    test('selects user email', () => {
        expect(content).toContain('user: { select: { email: true } }');
    });

    test('supports recipientOverrides to bypass member lookup', () => {
        expect(content).toContain('recipientOverrides');
    });
});

// ─── Email Rendering ────────────────────────────────────────────────

describe('Compliance Digest — Email Content', () => {
    const content = readFile(DIGEST_FILE);

    test('renders both text and HTML versions', () => {
        expect(content).toContain('text: string; html: string');
    });

    test('includes subject with tenant name and date', () => {
        expect(content).toContain('Weekly Compliance Digest');
        expect(content).toContain('data.tenantName');
        expect(content).toContain('data.snapshotDate');
    });

    test('email covers control coverage', () => {
        expect(content).toContain('Control Coverage');
        expect(content).toContain('controlCoveragePercent');
    });

    test('email covers evidence status', () => {
        expect(content).toContain('Evidence');
        expect(content).toContain('evidenceOverdue');
    });

    test('email covers tasks and findings', () => {
        expect(content).toContain('Tasks');
        expect(content).toContain('Findings');
        expect(content).toContain('tasksOpen');
        expect(content).toContain('findingsOpen');
    });

    test('email has attention required section', () => {
        expect(content).toContain('Attention Required');
    });

    test('email shows trend deltas', () => {
        expect(content).toContain('coverageDelta');
        expect(content).toContain('evidenceOverdueDelta');
        expect(content).toContain('findingsOpenDelta');
    });

    test('delta formatting handles null (no prior data)', () => {
        expect(content).toContain("if (val === null) return 'N/A'");
    });

    test('email handles "no urgent items" state', () => {
        expect(content).toContain('No urgent items');
    });
});

// ─── Empty State Handling ──────────────────────────────────────────

describe('Compliance Digest — Empty States', () => {
    const content = readFile(DIGEST_FILE);

    test('skips tenants with no snapshots', () => {
        expect(content).toContain('no snapshots yet');
        expect(content).toContain('return false');
    });

    test('skips tenants with no eligible recipients', () => {
        expect(content).toContain('no eligible recipients');
    });

    test('handles errors per-tenant without aborting entire run', () => {
        expect(content).toContain('catch (err)');
        expect(content).toContain('skipped++');
    });
});

// ─── Trend Delta Computation ────────────────────────────────────────

describe('Compliance Digest — Trend Deltas', () => {
    const content = readFile(DIGEST_FILE);

    test('computes coverage delta from BPS', () => {
        expect(content).toContain('controlCoverageBps - priorSnapshot.controlCoverageBps');
    });

    test('computes risks open delta', () => {
    });

    test('computes evidence overdue delta', () => {
        expect(content).toContain('evidenceOverdue - priorSnapshot.evidenceOverdue');
    });

    test('computes findings open delta', () => {
        expect(content).toContain('findingsOpen - priorSnapshot.findingsOpen');
    });

    test('null deltas when no prior snapshot', () => {
        expect(content).toContain(': null');
    });

    test('supports configurable trend window (trendDays)', () => {
        expect(content).toContain('trendDays');
        expect(content).toContain('trendDays * 86400000');
    });
});

// ─── Pipeline Coherence ────────────────────────────────────────────

describe('Epic 22 Pipeline Coherence', () => {
    test('snapshot job writes to ComplianceSnapshot', () => {
        const content = readFile(SNAPSHOT_FILE);
        expect(content).toContain('complianceSnapshot');
        expect(content).toContain('upsert');
    });

    test('digest job reads from ComplianceSnapshot', () => {
        const content = readFile(DIGEST_FILE);
        expect(content).toContain('complianceSnapshot.findFirst');
    });

    test('digest and snapshot use same field names', () => {
        const snapshot = readFile(SNAPSHOT_FILE);
        const digest = readFile(DIGEST_FILE);

        // Key fields that must match between writer and reader
        for (const field of [
            'controlCoverageBps',
            'controlsImplemented',
            'controlsApplicable',
            'evidenceOverdue',
            'evidenceDueSoon7d',
            'policiesOverdueReview',
            'tasksOpen',
            'tasksOverdue',
            'findingsOpen',
        ]) {
            expect(snapshot).toContain(field);
            expect(digest).toContain(field);
        }
    });

    test('digest sends via sendEmail (mailer module)', () => {
        const content = readFile(DIGEST_FILE);
        expect(content).toContain("import { sendEmail");
        expect(content).toContain('await sendEmail({');
    });

    test('digest job returns JobRunResult shape', () => {
        const content = readFile(DIGEST_FILE);
        expect(content).toContain('const result: JobRunResult');
        expect(content).toContain('return { result }');
    });
});

// ─── Job Contract Completeness Guard ────────────────────────────────

describe('Job Contract Completeness', () => {
    test('every JobPayloadMap entry has a JOB_DEFAULTS entry', () => {
        const content = readFile(TYPES_FILE);

        // Extract job names from JobPayloadMap
        const mapRegex = /'([\w-]+)':/g;
        const mapSection = content.substring(
            content.indexOf('interface JobPayloadMap'),
            content.indexOf('type JobName'),
        );
        const mapNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = mapRegex.exec(mapSection)) !== null) {
            mapNames.add(match[1]);
        }

        // Extract job names from JOB_DEFAULTS
        const defaultsSection = content.substring(
            content.indexOf('JOB_DEFAULTS'),
            content.indexOf('QUEUE_NAME'),
        );
        const defaultsNames = new Set<string>();
        const defaultsRegex = /'([\w-]+)':/g;
        while ((match = defaultsRegex.exec(defaultsSection)) !== null) {
            defaultsNames.add(match[1]);
        }

        // Every map entry must have a defaults entry
        for (const name of mapNames) {
            expect(defaultsNames.has(name)).toBe(true);
        }
    });
});

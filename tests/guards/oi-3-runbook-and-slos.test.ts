/**
 * Epic OI-3 — runbook + SLOs ratchet (final OI-3 layer).
 *
 * Locks both docs against drift AND asserts the alignment between
 * the docs and the underlying machinery shipped across OI-1/OI-2/OI-3:
 *
 *   - SLOs cover the 4 OI-3-spec targets (availability, read+write
 *     latency split, RPO 1h, RTO 4h)
 *   - Each SLO references the metric/mechanism that powers it
 *   - Incident-response.md has the 7 required playbooks
 *   - Each playbook references the specific alert + dashboard +
 *     command path that drives it
 *   - The runbook's "Operational alignment" section names every
 *     prior epic's deliverable that it depends on
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

describe('OI-3 — SLOs (docs/slos.md)', () => {
    const SLO_DOC = 'docs/slos.md';

    it('exists', () => {
        expect(exists(SLO_DOC)).toBe(true);
    });

    it('declares availability ≥ 99.9% (OI-3 spec)', () => {
        const src = read(SLO_DOC);
        // The existing SLO 1 (pre-OI-3) already covered availability.
        // Locked here so a future "simplify" PR can't drop the target.
        expect(src).toMatch(/99\.9\s*%/);
    });

    it('splits API latency into READS (<500ms) and WRITES (<1000ms) per OI-3 spec', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 2:\s*API Latency\s*[—-]\s*Reads/i);
        expect(src).toMatch(/SLO 2b:\s*API Latency\s*[—-]\s*Writes/i);
        // Read target
        expect(src).toMatch(/95th percentile of GET requests\s*<\s*500ms/i);
        // Write target
        expect(src).toMatch(/95th percentile of state-mutating requests\s*<\s*1000ms/i);
    });

    it('read latency formula filters by GET|HEAD method', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/http_method=~"GET\|HEAD"/);
    });

    it('write latency formula filters by mutating methods', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/http_method=~"POST\|PUT\|PATCH\|DELETE"/);
    });

    it('declares RPO 1 hour (OI-3 spec)', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 6:\s*RPO/i);
        expect(src).toMatch(/Maximum\s+1\s+hour\s+of\s+data\s+loss/i);
    });

    it('declares RTO 4 hours (OI-3 spec)', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 7:\s*RTO/i);
        expect(src).toMatch(/Service\s+restored\s+within\s+4\s+hours/i);
    });

    it('RPO is verified by the monthly restore-test.sh', () => {
        const src = read(SLO_DOC);
        // The restore-test script (OI-3 part 4) is the canonical
        // verification mechanism; a SLO doc that doesn't cite it
        // would mean the SLO is a number on paper, not a measured
        // commitment.
        expect(src).toMatch(/restore-test\.sh/);
    });

    it('RTO scenarios reference the actual recovery commands', () => {
        const src = read(SLO_DOC);
        // helm rollback, restore-db-instance — both must appear by
        // exact-name, since they're the canonical commands an
        // operator runs.
        expect(src).toMatch(/helm rollback/);
        expect(src).toMatch(/restore-db-instance/);
    });

    it('declares the repository SLO that uses OI-3 part 2 metrics', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/SLO 5:\s*Repository latency/i);
        // The metric name from OI-3 part 2
        expect(src).toMatch(/repo_method_duration/);
    });

    it('summary table contains all 8 SLOs (4 original + read/write split + repo + RPO + RTO)', () => {
        const src = read(SLO_DOC);
        // The summary table appears late in the doc and lists every SLO
        const summarySection = src.split('## SLO Summary Table')[1];
        expect(summarySection).toBeDefined();
        for (const target of [
            'API Availability',
            'API Latency — Reads',
            'API Latency — Writes',
            'API Error Rate',
            'Health Check Availability',
            'Repository Latency',
            'RPO (Recovery Point)',
            'RTO (Recovery Time)',
        ]) {
            expect(summarySection).toContain(target);
        }
    });

    it('revision history records the OI-3 update', () => {
        const src = read(SLO_DOC);
        expect(src).toMatch(/2026-04-27.*OI-3/);
    });
});

describe('OI-3 — Incident response runbook (docs/incident-response.md)', () => {
    const DOC = 'docs/incident-response.md';

    it('exists', () => {
        expect(exists(DOC)).toBe(true);
    });

    const REQUIRED_PLAYBOOKS = [
        ['App Down', 'app-down'],
        ['Database Unavailable', 'database-unavailable'],
        ['Redis OOM', 'redis-oom'],
        ['Queue Backlog', 'queue-backlog'],
        ['Certificate Expiry', 'certificate-expiry'],
        ['Rollback', 'rollback'],
        ['Data Breach Response', 'data-breach'],
    ] as const;

    it.each(REQUIRED_PLAYBOOKS)('contains the %s playbook', (label) => {
        const src = read(DOC);
        // Match "## <num>. <Label>" or "## <Label>"
        expect(src.toLowerCase()).toContain(label.toLowerCase());
    });

    it('quick-reference table maps every alert to a playbook', () => {
        const src = read(DOC);
        // Every alert from rules.yml that pages should appear in the
        // quick-reference. Lock the OI-3-spec alerts.
        for (const alert of [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'RedisMemoryHighWarning',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ]) {
            expect(src).toContain(alert);
        }
    });

    it('references the four OI-3 dashboards by UID', () => {
        const src = read(DOC);
        for (const uid of [
            'inflect-app-overview',
            'inflect-database',
            'inflect-redis',
            'inflect-bullmq',
        ]) {
            expect(src).toContain(uid);
        }
    });

    it('App Down playbook uses /api/livez (matches external uptime contract)', () => {
        const src = read(DOC);
        // The playbook must instruct curl/kubectl-curl to /api/livez —
        // the same endpoint the external uptime monitor probes.
        expect(src).toMatch(/curl[^`]*\/api\/livez/);
    });

    it('Rollback playbook uses helm rollback with explicit revision history', () => {
        const src = read(DOC);
        expect(src).toMatch(/helm history inflect-production/);
        expect(src).toMatch(/helm rollback inflect-production/);
        expect(src).toMatch(/--namespace inflect-production/);
    });

    it('Rollback playbook documents the migration-Job-not-re-run-on-rollback caveat', () => {
        const src = read(DOC);
        // expand-and-contract is THE mitigation. Without this the
        // rollback playbook is unsafe.
        expect(src.toLowerCase()).toMatch(/expand[\s-]and[\s-]contract/);
        // Migration Job is one-way
        expect(src).toMatch(/migration Job is one-way|hooks?\s+are\s+\*?\*?NOT\*?\*?\s+re-run|NOT.{1,5}re-run on rollback/i);
    });

    it('Database Unavailable playbook covers PgBouncer pool inspection', () => {
        const src = read(DOC);
        expect(src).toMatch(/SHOW POOLS/);
        expect(src).toMatch(/pgbouncer/i);
    });

    it('Database recovery from PITR uses restore-db-instance-to-point-in-time', () => {
        const src = read(DOC);
        expect(src).toMatch(/restore-db-instance-to-point-in-time/);
    });

    it('Data Breach playbook references the hash-chained AuditLog (preserves evidence)', () => {
        const src = read(DOC);
        expect(src).toMatch(/AuditLog/);
        expect(src).toMatch(/hash-chained/i);
    });

    it('Data Breach playbook references the Epic B v1→v2 sweep for KEK rotation', () => {
        const src = read(DOC);
        // The KEK rotation runbook lives in epic-b-encryption.md;
        // the incident-response runbook MUST point at it (regenerating
        // the KEK without the sweep is a data-loss event).
        expect(src).toMatch(/epic-b-encryption/);
        expect(src).toMatch(/v1.{0,5}v2/i);
    });

    it('Communication templates section has 5 named templates', () => {
        const src = read(DOC);
        const templates = [
            'PagerDuty incident',
            'Status page update — initial',
            'Status page update — mitigation in progress',
            'Status page update — resolved',
            'Internal Slack — incident channel kickoff',
        ];
        for (const t of templates) {
            expect(src).toContain(t);
        }
        // Plus the customer-email templates (degradation + breach)
        expect(src).toMatch(/Customer email\s*[—-]\s*service degradation/);
        expect(src).toMatch(/Customer email\s*[—-]\s*confirmed data breach/);
    });

    it('Severity definitions table includes both CRITICAL and WARNING tiers', () => {
        const src = read(DOC);
        expect(src).toMatch(/CRITICAL[\s\S]{0,200}PagerDuty/);
        expect(src).toMatch(/WARNING[\s\S]{0,200}Slack/);
    });

    it('Operational alignment section names every prior-epic deliverable', () => {
        const src = read(DOC);
        // The closing section MUST call out the dependencies so an
        // operator reading this doc cold sees the system map.
        expect(src).toMatch(/Operational alignment/i);
        expect(src).toMatch(/Epic OI-1/);
        expect(src).toMatch(/Epic OI-2/);
        expect(src).toMatch(/Epic OI-3/);
        // Specific deliverables. The restore drill is
        // `restore-test-gcp.sh` since 2026-08-01 — the AWS RDS script
        // it replaced named infrastructure this product never ran (see
        // tests/guards/oi-3-backup-restore.test.ts and
        // docs/backup-restore.md).
        expect(src).toMatch(/restore-test-gcp\.sh/);
        expect(src).toMatch(/manage_master_user_password/);
        expect(src).toMatch(/external-uptime\.yml/);
    });
});

describe('OI-3 — final readiness check (alignment)', () => {
    it('every alert with severity=critical has a corresponding playbook section', () => {
        const runbookSrc = read('docs/incident-response.md');
        const rulesSrc = read('infra/alerts/rules.yml');

        // Walk the rules YAML for critical alerts
        const criticalNames: string[] = [];
        const lines = rulesSrc.split('\n');
        let pendingAlert: string | null = null;
        for (const line of lines) {
            const alertMatch = line.match(/^\s*-\s*alert:\s*(\w+)/);
            if (alertMatch) {
                pendingAlert = alertMatch[1];
                continue;
            }
            if (pendingAlert && /severity:\s*critical/.test(line)) {
                criticalNames.push(pendingAlert);
                pendingAlert = null;
            }
        }
        expect(criticalNames.length).toBeGreaterThan(0);

        // Subset of criticals that must each be addressed in the runbook.
        // (Not every critical has a unique section — e.g. ApiP95LatencyCritical
        // is handled inside the Database playbook. We assert the
        // OI-3-spec criticals are referenced by NAME in the doc.)
        const MUST_BE_NAMED = [
            'DatabaseConnectionPoolExhausted',
            'RedisMemoryHighCritical',
            'QueueDepthBacklogCritical',
            'CertificateExpiryCritical',
        ];
        for (const name of MUST_BE_NAMED) {
            expect(criticalNames).toContain(name);
            expect(runbookSrc).toContain(name);
        }
    });

    it('SLO doc references the alert names that protect each SLO', () => {
        const src = read('docs/slos.md');
        // Latency SLO ↔ ApiP95Latency alerts; Error rate SLO ↔ ApiErrorRate alerts
        expect(src).toMatch(/ApiP95LatencyWarning/);
        expect(src).toMatch(/ApiP95LatencyCritical/);
    });

    it('runbook references the dashboards UIDs that each alert uses', () => {
        const runbook = read('docs/incident-response.md');
        const rules = read('infra/alerts/rules.yml');

        // Extract every `dashboard:` annotation value from rules.yml
        const annotated = Array.from(
            rules.matchAll(/dashboard:\s*"([^"]+)"/g),
            (m) => m[1],
        );
        const uniqueUids = new Set(
            annotated
                .map((url) => {
                    const m = url.match(/^\/d\/([^/]+)/);
                    return m ? m[1] : '';
                })
                .filter((u) => u),
        );

        for (const uid of uniqueUids) {
            // The runbook should mention every dashboard the alerts
            // route operators to.
            expect(runbook).toContain(uid);
        }
    });
});

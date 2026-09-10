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
 *
 * ── RE-POINTED 2026-09-10 (#842) ──────────────────────────────────
 *
 * Three assertions in this file used to REQUIRE, by exact match, the
 * Helm-release rollback commands and the AWS RDS restore command — in
 * `docs/incident-response.md`, the document that is read DURING an
 * incident, and in `docs/slos.md`'s RTO scenarios. There is no chart
 * (deleted in #848), no Helm release, no cluster and no RDS. So the
 * suite was green, and correcting either doc would have turned it red:
 * exactly the GAP-12 shape #840 removed from `deployment.md`, one
 * document over.
 *
 * The reason these assertions exist is sound — an incident runbook
 * must contain a rollback playbook, and an RTO target must name the
 * mechanism that meets it. Only the answers were wrong. They now
 * assert the VM path AND the absence of the impossible instruction,
 * so drifting back is what turns them red.
 *
 * A green test is evidence the doc matches the assertion, never that
 * the assertion matches reality. These describe claims about the
 * world; re-check them against the world, not just against the doc.
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

    it('RPO discloses the ACHIEVED figure next to the target', () => {
        const src = read(SLO_DOC);
        // #842. The assertion above locks the 1-hour TARGET. On its own
        // that is half a ratchet: a future edit could delete the
        // disclosure that the deployment delivers up to 24h and stay
        // green, leaving a reader planning an incident around a number
        // no backup can produce. Both halves are load-bearing.
        const slo6 = src.split('## SLO 6: RPO')[1]?.split('## SLO 7:')[0];
        expect(slo6).toBeDefined();
        expect(slo6.length).toBeGreaterThan(1000); // positive control
        expect(slo6).toMatch(/NOT CURRENTLY MET|not met|aspirational/i);
        expect(slo6).toMatch(/up to\s+\*?\*?24\*?\*?\s+hours|24h/i);
        // And it must say what closing the gap would take, so "why is
        // this still open?" is answerable without re-deriving it.
        expect(slo6).toMatch(/WAL|continuous archiving|managed Postgres/i);
    });

    it('RPO is verified by the monthly restore-test.sh', () => {
        const src = read(SLO_DOC);
        // The restore-test script (OI-3 part 4) is the canonical
        // verification mechanism; a SLO doc that doesn't cite it
        // would mean the SLO is a number on paper, not a measured
        // commitment.
        expect(src).toMatch(/restore-test\.sh/);
    });

    it('RTO scenarios reference the recovery levers this deployment actually has', () => {
        const src = read(SLO_DOC);
        // #842: was `helm rollback` + `restore-db-instance`. Neither
        // exists. The three real levers, worst case last:
        expect(src).toMatch(/deploy\/apply\.sh/);
        expect(src).toMatch(/deploy\/rollback\/\*?\.?down\.sql|deploy\/rollback\/<migration>\.down\.sql/);
        expect(src).toMatch(/agrent-daily-snapshot/);
        // ...and the runbook that carries the procedures.
        expect(src).toMatch(/docs\/runbooks\/production-vm\.md/);
    });

    it('RTO scenarios do NOT instruct an operator toward a cluster or an AWS account', () => {
        const src = read(SLO_DOC);
        const rto = src.split('## SLO 7: RTO')[1];
        // Positive control: the section must exist and be substantial,
        // or every `not.toMatch` below passes vacuously.
        expect(rto).toBeDefined();
        expect(rto.length).toBeGreaterThan(1000);
        // The runnable falsehoods. A prose mention inside the
        // correction note is fine and deliberate; a COMMAND is not.
        expect(rto).not.toMatch(/`?helm rollback`?\s/);
        expect(rto).not.toMatch(/restore-db-instance/);
        expect(rto).not.toMatch(/aws secretsmanager/);
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

    it('Rollback playbook gives the VM rollback path, with the image tag and the apply script', () => {
        const src = read(DOC);
        const rollback = src.split('## 6. Rollback')[1]?.split('## 7. Data Breach')[0];
        // Positive control — an empty or renamed section must fail here,
        // not sail through the assertions below.
        expect(rollback).toBeDefined();
        expect(rollback.length).toBeGreaterThan(2000);
        // The image pin: which registry, which tag shape, applied how.
        expect(rollback).toMatch(/ghcr\.io\/rodnapamet\/agri-saas/);
        expect(rollback).toMatch(/sha-<short>|sha-\w+/);
        expect(rollback).toMatch(/deploy\/apply\.sh/);
        // The schema half — the reason a pin alone is not a rollback.
        expect(rollback).toMatch(/deploy\/rollback\//);
        // And how to tell whether you are on the intended build.
        expect(rollback).toMatch(/\/api\/readyz/);
    });

    it('Rollback playbook does NOT instruct on-call to roll back a Helm release', () => {
        const src = read(DOC);
        // #842 — the exact strings this file used to REQUIRE. There is
        // no chart, no release and no cluster for them to address, and
        // this is the document someone reads under time pressure.
        //
        // Scoped to the RUNNABLE release-named form on purpose: the
        // "Operational alignment" table still names `helm rollback` in
        // a struck-through correction row, which is a record of what
        // was wrong, not an instruction. Sections 2-5 still carry
        // uncorrected EKS triage and are flagged by the doc's banner;
        // they are tracked separately, not silently tolerated here.
        expect(src).not.toMatch(/helm\s+(history|rollback)\s+inflect-production/);
    });

    it('Rollback playbook documents that an image rollback leaves the schema migrated', () => {
        const src = read(DOC);
        // expand-and-contract is THE mitigation. Without this the
        // rollback playbook is unsafe.
        expect(src.toLowerCase()).toMatch(/expand[\s-]and[\s-]contract/);
        // #842: the old alternation described a Helm pre-upgrade Job.
        // The real mechanism is the container entrypoint — which is
        // why shipping an image is what applies a migration, and why
        // pinning the image back does not un-apply it.
        expect(src).toMatch(/entrypoint\.sh/);
        expect(src).toMatch(/prisma migrate deploy/);
        expect(src).toMatch(/shipping an image is what applies a migration/i);
        expect(src).toMatch(/one-way|fails outright|NOT reverted/i);
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

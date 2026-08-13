/**
 * Evidence Retention Hardening — CI Guardrails
 *
 * These tests ensure retention enforcement is consistently applied:
 * 1. Evidence roll-up scoring excludes archived evidence
 * 2. Evidence linking guards exist
 * 3. Notification job is idempotent
 * 4. Scoring code always filters isArchived
 *
 * GRC teardown phase 2 deleted `app-layer/usecases/audit-readiness-scoring.ts`
 * (ISO/NIS2 audit-readiness scoring) along with the Framework/Clause models
 * it scored against. Sections 1 and 5 below used to read that file. The
 * INVARIANT they protected — "an aggregate that scores evidence must not
 * count archived or soft-deleted rows" — outlived it, so both sections are
 * RE-POINTED at the surviving equivalent, `DashboardRepository`'s
 * `getEvidenceExpiry` / `getUpcomingExpirations` evidence roll-ups, rather
 * than dropped. The one assertion with no survivor (the deleted scorer's
 * user-facing "archived/expired excluded" gap-detail copy) is gone.
 */
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.resolve('src');

// The surviving evidence-scoring surface (see teardown note above).
const DASHBOARD_REPO = path.join(SRC_ROOT, 'app-layer/repositories/DashboardRepository.ts');

// ─── 1) Evidence roll-ups exclude archived evidence ───

describe('Retention Hardening — Evidence roll-up scoring', () => {
    test('dashboard evidence roll-up filters isArchived', () => {
        const content = fs.readFileSync(DASHBOARD_REPO, 'utf-8');
        // Must contain isArchived: false in evidence query context
        expect(content).toContain('isArchived: false');
    });

    test('dashboard evidence roll-up filters deletedAt', () => {
        const content = fs.readFileSync(DASHBOARD_REPO, 'utf-8');
        expect(content).toContain('deletedAt: null');
    });
});

// ─── 2) Evidence linking block ───

describe('Retention Hardening — Evidence linking block', () => {
    test('assertNotArchived function exists in evidence-retention', () => {
        const mod = require('@/app-layer/usecases/evidence-retention');
        expect(typeof mod.assertNotArchived).toBe('function');
    });
});

// ─── 3) Notification job exports ───

describe('Retention Hardening — Notification job', () => {
    test('notification job module exports runEvidenceRetentionNotifications', () => {
        const mod = require('@/app-layer/jobs/retention-notifications');
        expect(typeof mod.runEvidenceRetentionNotifications).toBe('function');
    });
});

// ─── 4) Retention metrics ───

describe('Retention Hardening — Metrics', () => {
    test('getRetentionMetrics function exists', () => {
        const mod = require('@/app-layer/usecases/evidence-retention');
        expect(typeof mod.getRetentionMetrics).toBe('function');
    });

    test('metrics route exists', () => {
        const routeDir = path.resolve('src/app/api/t/[tenantSlug]/evidence/retention');
        expect(fs.existsSync(path.join(routeDir, 'metrics/route.ts'))).toBe(true);
    });

    test('metrics route has no direct prisma import', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app/api/t/[tenantSlug]/evidence/retention/metrics/route.ts'), 'utf-8'
        );
        expect(content).not.toContain("from '@/lib/prisma'");
        expect(content).not.toContain('from "@/lib/prisma"');
    });
});

// ─── 5) CI guardrail: scoring code isArchived check ───

/**
 * Extract the argument text of every `db.evidence.<method>(...)` call in
 * `src`, paren-matched so nested object literals are captured whole.
 */
function evidenceCallArgs(src: string): string[] {
    const out: string[] = [];
    const re = /db\.evidence\.(?:count|findMany|findFirst|findUnique|aggregate|groupBy)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        let depth = 0;
        let i = m.index + m[0].length - 1; // index of the opening '('
        const start = i;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')') {
                depth--;
                if (depth === 0) break;
            }
        }
        out.push(src.slice(start + 1, i));
    }
    return out;
}

describe('Retention Hardening — CI guardrail', () => {
    test('dashboard evidence roll-ups never query evidence without isArchived + deletedAt filters', () => {
        const content = fs.readFileSync(DASHBOARD_REPO, 'utf-8');
        const calls = evidenceCallArgs(content);

        // Floor kept at the original guard's 2 (it is a floor, not a
        // census); measured value at the time of writing is 6 — five
        // `count`s in getEvidenceExpiry plus one `findMany` in
        // getUpcomingExpirations.
        expect(calls.length).toBeGreaterThanOrEqual(2);

        // Every one of them must be archive- and soft-delete-aware,
        // either inline or via the shared `base` where-fragment.
        for (const args of calls) {
            const viaBase = /\.\.\.base\b/.test(args);
            expect(viaBase || /isArchived/.test(args)).toBe(true);
            expect(viaBase || /deletedAt/.test(args)).toBe(true);
        }

        // …and the shared fragment itself must carry both filters, or the
        // `...base` escape above would be a hole.
        expect(content).toMatch(/const base = \{[^}]*deletedAt: null[^}]*isArchived: false[^}]*\}/);
    });

    test('notification job is idempotent — checks for existing tasks', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/jobs/retention-notifications.ts'), 'utf-8'
        );
        // Must check for existing task before creating new one
        expect(content).toContain('findFirst');
        expect(content).toContain('skippedDuplicate');
    });

    test('sweep job is idempotent — only archives non-archived', () => {
        const content = fs.readFileSync(
            path.join(SRC_ROOT, 'app-layer/jobs/retention.ts'), 'utf-8'
        );
        expect(content).toContain('isArchived: false');
    });
});

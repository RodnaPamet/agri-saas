/**
 * Epic O-3 — portfolio DTO contract tests.
 *
 * Validates the Zod shapes against representative payloads (one
 * happy + one rejection per DTO) plus the RAG threshold helper.
 * Locks the role-to-permission mapping that the org dashboard UI
 * and the org-scoped API routes will rely on.
 */
import {
    PortfolioSummarySchema,
    TenantHealthRowSchema,
    PortfolioTrendSchema,
    RagBadgeSchema,
    computeRag,
} from '@/app-layer/schemas/portfolio';

describe('Epic O-3 — Portfolio DTO schemas', () => {
    // ── PortfolioSummary ──────────────────────────────────────────────

    it('PortfolioSummary accepts a fully-populated org', () => {
        const payload = {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: new Date().toISOString(),
            tenants: { total: 3, snapshotted: 2, pending: 1 },
            evidence: { total: 200, overdue: 4, dueSoon7d: 10 },
            tasks: { open: 25, overdue: 3 },
            rag: { green: 1, amber: 1, red: 0, pending: 1 },
        };
        expect(() => PortfolioSummarySchema.parse(payload)).not.toThrow();
    });

    it('PortfolioSummary rejects a negative count', () => {
        const payload = {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: new Date().toISOString(),
            tenants: { total: -1, snapshotted: 0, pending: 0 },
            evidence: { total: 0, overdue: 0, dueSoon7d: 0 },
            tasks: { open: 0, overdue: 0 },
            rag: { green: 0, amber: 0, red: 0, pending: 0 },
        };
        expect(() => PortfolioSummarySchema.parse(payload)).toThrow();
    });

    // 'PortfolioSummary rejects coveragePercent > 100' lived here. Its
    // subject was the practices block's 0..100 bound, which left the DTO
    // with the practice models (GRC teardown phase 2). No surviving field
    // carries a range bound, so the case has nothing to assert — the
    // non-negative-integer rule is already covered by the test above.

    // ── TenantHealthRow ───────────────────────────────────────────────

    it('TenantHealthRow accepts a snapshotted tenant', () => {
        const row = {
            tenantId: 't-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
            drillDownUrl: '/t/acme-corp/dashboard',
            hasSnapshot: true,
            snapshotDate: '2026-04-26',
            overdueEvidence: 0,
            rag: 'GREEN',
        };
        expect(() => TenantHealthRowSchema.parse(row)).not.toThrow();
    });

    it('TenantHealthRow accepts a pending tenant (no snapshot, all metrics null)', () => {
        const row = {
            tenantId: 't-2',
            slug: 'fresh-tenant',
            name: 'Fresh Tenant',
            drillDownUrl: '/t/fresh-tenant/dashboard',
            hasSnapshot: false,
            snapshotDate: null,
            overdueEvidence: null,
            rag: null,
        };
        expect(() => TenantHealthRowSchema.parse(row)).not.toThrow();
    });

    it('TenantHealthRow rejects an invalid RAG badge', () => {
        const row = {
            tenantId: 't-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
            drillDownUrl: '/t/acme-corp/dashboard',
            hasSnapshot: true,
            snapshotDate: '2026-04-26',
            overdueEvidence: 0,
            rag: 'PURPLE', // not a valid enum value
        };
        expect(() => TenantHealthRowSchema.parse(row)).toThrow();
    });

    // ── PortfolioTrend ────────────────────────────────────────────────

    it('PortfolioTrend accepts an empty data-points array', () => {
        const t = {
            organizationId: 'org-1',
            daysRequested: 90,
            daysAvailable: 0,
            rangeStart: new Date().toISOString(),
            rangeEnd: new Date().toISOString(),
            tenantsAggregated: 0,
            dataPoints: [],
        };
        expect(() => PortfolioTrendSchema.parse(t)).not.toThrow();
    });

    it('PortfolioTrend rejects daysRequested = 0', () => {
        const t = {
            organizationId: 'org-1',
            daysRequested: 0,
            daysAvailable: 0,
            rangeStart: new Date().toISOString(),
            rangeEnd: new Date().toISOString(),
            tenantsAggregated: 0,
            dataPoints: [],
        };
        expect(() => PortfolioTrendSchema.parse(t)).toThrow();
    });

    // ── RAG enum / threshold helper ──────────────────────────────────

    it('RagBadgeSchema enumerates exactly GREEN, AMBER, RED', () => {
        for (const v of ['GREEN', 'AMBER', 'RED'] as const) {
            expect(() => RagBadgeSchema.parse(v)).not.toThrow();
        }
        expect(() => RagBadgeSchema.parse('YELLOW')).toThrow();
    });

    // ── computeRag thresholds ────────────────────────────────────────

    describe('computeRag', () => {
        // Two axes have now left this function. `criticalRisks` went with
        // the risk register; COVERAGE went with the GRC teardown (plan
        // §8f) because `practiceCoverageBps` stopped being computed —
        // every new snapshot carries the column default of 0, and the old
        // `coveragePercent < 60` arm would have painted EVERY tenant RED
        // while looking like a measurement. Overdue evidence is the one
        // remaining input, and evidence is a KEEP model.
        it('returns GREEN when there is no overdue evidence', () => {
            expect(computeRag({ overdueEvidence: 0 })).toBe('GREEN');
        });

        it('returns AMBER for 1–9 overdue evidence records', () => {
            expect(computeRag({ overdueEvidence: 1 })).toBe('AMBER');
            expect(computeRag({ overdueEvidence: 9 })).toBe('AMBER');
        });

        it('returns RED at 10 or more overdue evidence records', () => {
            expect(computeRag({ overdueEvidence: 10 })).toBe('RED');
            expect(computeRag({ overdueEvidence: 250 })).toBe('RED');
        });

        it('a tenant with nothing overdue is GREEN, not RED', () => {
            // The regression this replaces: a fresh tenant with an empty
            // snapshot scored 0% coverage and was reported RED. Zero
            // overdue evidence is the honest reading of "nothing wrong".
            expect(computeRag({ overdueEvidence: 0 })).toBe('GREEN');
        });
    });
});

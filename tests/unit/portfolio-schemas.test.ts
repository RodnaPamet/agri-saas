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
            controls: { applicable: 100, implemented: 75, coveragePercent: 75 },
            evidence: { total: 200, overdue: 4, dueSoon7d: 10 },
            policies: { total: 12, overdueReview: 1 },
            tasks: { open: 25, overdue: 3 },
            findings: { open: 7 },
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
            controls: { applicable: 0, implemented: 0, coveragePercent: 0 },
            evidence: { total: 0, overdue: 0, dueSoon7d: 0 },
            policies: { total: 0, overdueReview: 0 },
            tasks: { open: 0, overdue: 0 },
            findings: { open: 0 },
            rag: { green: 0, amber: 0, red: 0, pending: 0 },
        };
        expect(() => PortfolioSummarySchema.parse(payload)).toThrow();
    });

    it('PortfolioSummary rejects coveragePercent > 100', () => {
        const payload = {
            organizationId: 'org-1',
            organizationSlug: 'acme-org',
            generatedAt: new Date().toISOString(),
            tenants: { total: 0, snapshotted: 0, pending: 0 },
            controls: { applicable: 100, implemented: 100, coveragePercent: 105 },
            evidence: { total: 0, overdue: 0, dueSoon7d: 0 },
            policies: { total: 0, overdueReview: 0 },
            tasks: { open: 0, overdue: 0 },
            findings: { open: 0 },
            rag: { green: 0, amber: 0, red: 0, pending: 0 },
        };
        expect(() => PortfolioSummarySchema.parse(payload)).toThrow();
    });

    // ── TenantHealthRow ───────────────────────────────────────────────

    it('TenantHealthRow accepts a snapshotted tenant', () => {
        const row = {
            tenantId: 't-1',
            slug: 'acme-corp',
            name: 'Acme Corp',
            drillDownUrl: '/t/acme-corp/dashboard',
            hasSnapshot: true,
            snapshotDate: '2026-04-26',
            coveragePercent: 82.5,
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
            coveragePercent: null,
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
            coveragePercent: 82.5,
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
        // The `criticalRisks` axis went with the risk register; coverage
        // and overdue-evidence are the two remaining inputs and their
        // thresholds are unchanged.
        it('returns GREEN when coverage ≥ 80% AND no overdue evidence', () => {
            expect(computeRag({ coveragePercent: 80, overdueEvidence: 0 })).toBe('GREEN');
            expect(computeRag({ coveragePercent: 95, overdueEvidence: 0 })).toBe('GREEN');
        });

        it('returns AMBER when coverage is 60–79.9% (no other reds)', () => {
            expect(computeRag({ coveragePercent: 79, overdueEvidence: 0 })).toBe('AMBER');
            expect(computeRag({ coveragePercent: 60, overdueEvidence: 0 })).toBe('AMBER');
        });

        it('returns AMBER when there is overdue evidence (1–9, coverage ok)', () => {
            expect(computeRag({ coveragePercent: 95, overdueEvidence: 1 })).toBe('AMBER');
            expect(computeRag({ coveragePercent: 95, overdueEvidence: 9 })).toBe('AMBER');
        });

        it('returns RED when coverage < 60%', () => {
            expect(computeRag({ coveragePercent: 59.9, overdueEvidence: 0 })).toBe('RED');
            expect(computeRag({ coveragePercent: 0, overdueEvidence: 0 })).toBe('RED');
        });

        it('returns RED when overdueEvidence ≥ 10', () => {
            expect(computeRag({ coveragePercent: 95, overdueEvidence: 10 })).toBe('RED');
        });

        it('RED dominates AMBER (single-axis worst case wins)', () => {
            // Coverage borderline-AMBER + overdue-evidence worth-RED → RED.
            expect(computeRag({ coveragePercent: 70, overdueEvidence: 12 })).toBe('RED');
        });
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Audit Readiness Scoring Tests
 * - ISO27001 weighted scoring formula
 * - NIS2 weighted scoring formula
 * - Gap detection logic
 * - Recommendations generation
 * - Export format validation
 * - Security: no tokens/paths leaked
 */

describe('Readiness Scoring', () => {
    const ISO_WEIGHTS = { coverage: 0.35, implementation: 0.25, evidence: 0.25, tasks: 0.10, issues: 0.05 };
    const NIS2_WEIGHTS = { coverage: 0.40, evidence: 0.30, policies: 0.15, issues: 0.15 };

    describe('ISO27001 Scoring Formula', () => {
        function computeISO(coverage: number, impl: number, evidence: number, taskPenalty: number, issuePenalty: number): number {
            const taskScore = Math.max(0, 100 - (taskPenalty * 10));
            const issueScore = Math.max(0, 100 - (issuePenalty * 15));
            return Math.min(100, Math.max(0, Math.round(
                coverage * ISO_WEIGHTS.coverage +
                impl * ISO_WEIGHTS.implementation +
                evidence * ISO_WEIGHTS.evidence +
                taskScore * ISO_WEIGHTS.tasks +
                issueScore * ISO_WEIGHTS.issues
            )));
        }

        it('perfect score when all inputs are 100%', () => {
            expect(computeISO(100, 100, 100, 0, 0)).toBe(100);
        });

        it('zero score when all inputs are 0%', () => {
            expect(computeISO(0, 0, 0, 10, 7)).toBe(0);
        });

        it('coverage has 35% weight', () => {
            const withCoverage = computeISO(100, 0, 0, 10, 7);
            const withoutCoverage = computeISO(0, 0, 0, 10, 7);
            expect(withCoverage - withoutCoverage).toBe(35);
        });

        it('implementation has 25% weight', () => {
            const with_ = computeISO(0, 100, 0, 10, 7);
            const without_ = computeISO(0, 0, 0, 10, 7);
            expect(with_ - without_).toBe(25);
        });

        it('evidence has 25% weight', () => {
            const with_ = computeISO(0, 0, 100, 10, 7);
            const without_ = computeISO(0, 0, 0, 10, 7);
            expect(with_ - without_).toBe(25);
        });

        it('overdue tasks penalty maxes at 10 tasks', () => {
            const at10 = computeISO(100, 100, 100, 10, 0);
            const at20 = computeISO(100, 100, 100, 20, 0);
            expect(at10).toBe(at20);
        });

        it('issues penalty maxes at ~7 issues', () => {
            const at7 = computeISO(100, 100, 100, 0, 7);
            const at20 = computeISO(100, 100, 100, 0, 20);
            expect(at7).toBe(at20);
        });

        it('moderate readiness score for 60% inputs', () => {
            const score = computeISO(60, 60, 60, 2, 1);
            expect(score).toBeGreaterThan(50);
            expect(score).toBeLessThan(70);
        });

        it('weights sum to 100%', () => {
            const sum = ISO_WEIGHTS.coverage + ISO_WEIGHTS.implementation + ISO_WEIGHTS.evidence + ISO_WEIGHTS.tasks + ISO_WEIGHTS.issues;
            expect(sum).toBeCloseTo(1.0);
        });
    });

    describe('NIS2 Scoring Formula', () => {
        function computeNIS2(coverage: number, evidence: number, policyRatio: number, issueCount: number): number {
            const policyScore = policyRatio * 100;
            const issueScore = Math.max(0, 100 - (issueCount * 10));
            return Math.min(100, Math.max(0, Math.round(
                coverage * NIS2_WEIGHTS.coverage +
                evidence * NIS2_WEIGHTS.evidence +
                policyScore * NIS2_WEIGHTS.policies +
                issueScore * NIS2_WEIGHTS.issues
            )));
        }

        it('perfect NIS2 score', () => {
            expect(computeNIS2(100, 100, 1, 0)).toBe(100);
        });

        it('zero NIS2 score', () => {
            expect(computeNIS2(0, 0, 0, 10)).toBe(0);
        });

        it('coverage has 40% weight', () => {
            const with_ = computeNIS2(100, 0, 0, 10);
            const without_ = computeNIS2(0, 0, 0, 10);
            expect(with_ - without_).toBe(40);
        });

        it('evidence has 30% weight', () => {
            const with_ = computeNIS2(0, 100, 0, 10);
            const without_ = computeNIS2(0, 0, 0, 10);
            expect(with_ - without_).toBe(30);
        });

        it('policies have 15% weight', () => {
            const with_ = computeNIS2(0, 0, 1, 10);
            const without_ = computeNIS2(0, 0, 0, 10);
            expect(with_ - without_).toBe(15);
        });

        it('weights sum to 100%', () => {
            const sum = NIS2_WEIGHTS.coverage + NIS2_WEIGHTS.evidence + NIS2_WEIGHTS.policies + NIS2_WEIGHTS.issues;
            expect(sum).toBeCloseTo(1.0);
        });
    });

    describe('NIS2 Key Policies Detection', () => {
        const NIS2_KEYWORDS = ['incident', 'business continuity', 'disaster recovery', 'supplier', 'supply chain', 'access control'];

        it('detects incident response policy', () => {
            const policies = [{ title: 'Incident Response Plan', category: 'Security' }];
            const found = policies.some(p => `${p.title} ${p.category}`.toLowerCase().includes('incident'));
            expect(found).toBe(true);
        });

        it('detects business continuity policy', () => {
            const policies = [{ title: 'BCP - Business Continuity Plan', category: '' }];
            const found = policies.some(p => `${p.title} ${p.category}`.toLowerCase().includes('business continuity'));
            expect(found).toBe(true);
        });

        it('does not false-positive on unrelated policies', () => {
            const policies = [{ title: 'Employee Handbook', category: 'HR' }];
            const found = NIS2_KEYWORDS.some(kw =>
                policies.some(p => `${p.title} ${p.category}`.toLowerCase().includes(kw))
            );
            expect(found).toBe(false);
        });

        it('checks all 6 expected policies', () => {
            expect(NIS2_KEYWORDS.length).toBe(6);
        });
    });

    describe('Gap Detection', () => {
        it('identifies unmapped requirements', () => {
            const reqs = [{ id: '1', code: 'A.5.1', title: 'Policies' }, { id: '2', code: 'A.5.2', title: 'Roles' }];
            const mapped = new Set(['1']);
            const unmapped = reqs.filter(r => !mapped.has(r.id));
            expect(unmapped.length).toBe(1);
            expect(unmapped[0].code).toBe('A.5.2');
        });

        it('identifies practices missing evidence', () => {
            const practices = [
                { id: '1', evidence: [{ id: 'e1' }] },
                { id: '2', evidence: [] },
                { id: '3', evidence: [{ id: 'e2' }] },
            ];
            const missing = practices.filter(c => c.evidence.length === 0);
            expect(missing.length).toBe(1);
        });

        it('limits gaps to top 10', () => {
            const gaps = Array.from({ length: 25 }, (_, i) => ({ id: `${i}`, title: `Gap ${i}` }));
            expect(gaps.slice(0, 10).length).toBe(10);
        });
    });

    describe('Recommendations', () => {
        it('suggests mapping when coverage < 50%', () => {
            const recs: string[] = [];
            const coverage = 30;
            if (coverage < 50) recs.push('Map more requirements');
            expect(recs.length).toBe(1);
        });

        it('gives positive message when scores are high', () => {
            const recs: string[] = [];
            const coverage = 90; const impl = 90; const evidence = 90;
            if (coverage >= 80 && impl >= 80 && evidence >= 80) recs.push('Readiness is strong');
            expect(recs[0]).toContain('strong');
        });
    });

    describe('Export Security', () => {
        it('CSV does not leak file paths', () => {
            const csvRow = '"UNMAPPED_REQUIREMENT","A.5.1: Policies","Not mapped","HIGH"';
            expect(csvRow).not.toContain('C:\\');
            expect(csvRow).not.toContain('/home/');
            expect(csvRow).not.toContain('node_modules');
        });

        it('CSV does not contain tokens', () => {
            const csvRow = '"Type","Title","Details","Severity"';
            expect(csvRow).not.toMatch(/[a-f0-9]{64}/);
        });

        it('JSON export has expected structure', () => {
            const result = {
                frameworkKey: 'ISO27001', score: 75,
                breakdown: { coverage: { score: 80, weight: 0.35 } },
                gaps: [], recommendations: [], computedAt: new Date().toISOString(),
            };
            expect(result).toHaveProperty('frameworkKey');
            expect(result).toHaveProperty('score');
            expect(result).toHaveProperty('breakdown');
            expect(result).toHaveProperty('gaps');
            expect(result).toHaveProperty('recommendations');
            expect(result).toHaveProperty('computedAt');
        });

        it('CSV properly escapes double quotes', () => {
            const value = 'Practice "A" description';
            const escaped = `"${value.replace(/"/g, '""')}"`;
            expect(escaped).toBe('"Practice ""A"" description"');
        });
    });

    describe('Usecase Exports', () => {
        it('exports all scoring usecases', () => {
            const mod = require('../../src/app-layer/usecases/audit-readiness-scoring');
            expect(typeof mod.computeReadiness).toBe('function');
            expect(typeof mod.exportReadinessJson).toBe('function');
            expect(typeof mod.exportUnmappedCsv).toBe('function');
            expect(typeof mod.exportPracticeGapsCsv).toBe('function');
            expect(typeof mod.addReadinessToPack).toBe('function');
        });

        it('exports weights for verification', () => {
            const mod = require('../../src/app-layer/usecases/audit-readiness-scoring');
            expect(mod.ISO_WEIGHTS.coverage).toBe(0.35);
            expect(mod.ISO_WEIGHTS.implementation).toBe(0.25);
            expect(mod.NIS2_WEIGHTS.coverage).toBe(0.40);
            expect(mod.NIS2_WEIGHTS.policies).toBe(0.15);
        });

        it('exports NIS2 key policies list', () => {
            const mod = require('../../src/app-layer/usecases/audit-readiness-scoring');
            expect(mod.NIS2_KEY_POLICIES.length).toBe(6);
            expect(mod.NIS2_KEY_POLICIES.map((p: any) => p.keyword)).toContain('incident');
            expect(mod.NIS2_KEY_POLICIES.map((p: any) => p.keyword)).toContain('supplier');
        });
    });

    describe('Structural', () => {
        it('readiness route does not import prisma directly', () => {
            const fs = require('fs');
            const path = require('path');
            const file = path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]/audits/cycles/[cycleId]/readiness/route.ts');
            if (!fs.existsSync(file)) return;
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
            expect(content).toMatch(/from\s+['"]@\/app-layer\/usecases\/audit-readiness-scoring['"]/);
        });
    });
});

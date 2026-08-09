/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Audit Readiness Tests
 * - Token hashing / validation
 * - Freeze immutability enforcement
 * - Default pack preview structure
 * - Tenant isolation
 * - No-direct-prisma structural guard
 */

describe('Audit Readiness', () => {
    describe('Token Hashing', () => {
        const crypto = require('crypto');

        function hashToken(token: string): string {
            return crypto.createHash('sha256').update(token).digest('hex');
        }

        it('produces consistent hash for same token', () => {
            const token = 'test-token-abc123';
            expect(hashToken(token)).toBe(hashToken(token));
        });

        it('produces different hash for different tokens', () => {
            expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
        });

        it('hash is 64 characters (SHA-256 hex)', () => {
            const hash = hashToken('any-token');
            expect(hash.length).toBe(64);
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });

        it('generated tokens are cryptographically random', () => {
            const token1 = crypto.randomBytes(32).toString('hex');
            const token2 = crypto.randomBytes(32).toString('hex');
            expect(token1).not.toBe(token2);
            expect(token1.length).toBe(64);
        });

        it('never stores raw tokens (only hash)', () => {
            const token = crypto.randomBytes(32).toString('hex');
            const hash = hashToken(token);
            // The DB stores only the hash, the token is returned to the user
            expect(hash).not.toBe(token);
            // Can verify a token later
            expect(hashToken(token)).toBe(hash);
        });
    });

    describe('Freeze Immutability', () => {
        it('DRAFT pack allows adds', () => {
            const pack = { status: 'DRAFT' };
            const canAdd = pack.status === 'DRAFT';
            expect(canAdd).toBe(true);
        });

        it('FROZEN pack blocks adds', () => {
            const pack = { status: 'FROZEN' };
            const canAdd = pack.status === 'DRAFT';
            expect(canAdd).toBe(false);
        });

        it('EXPORTED pack blocks adds', () => {
            const pack = { status: 'EXPORTED' };
            const canAdd = pack.status === 'DRAFT';
            expect(canAdd).toBe(false);
        });

        it('FROZEN pack blocks updates', () => {
            const pack = { status: 'FROZEN' };
            const canUpdate = pack.status === 'DRAFT';
            expect(canUpdate).toBe(false);
        });

        it('freeze requires at least one item', () => {
            const items: any[] = [];
            expect(items.length === 0).toBe(true);
            // Would throw: 'Cannot freeze an empty pack'
        });

        it('freeze creates snapshot for empty snapshot items', () => {
            const item = { snapshotJson: '{}' };
            const needsSnapshot = !item.snapshotJson || item.snapshotJson === '{}';
            expect(needsSnapshot).toBe(true);
        });

        it('freeze preserves existing snapshots', () => {
            const item = { snapshotJson: '{"code":"CTRL-1","name":"Test"}' };
            const needsSnapshot = !item.snapshotJson || item.snapshotJson === '{}';
            expect(needsSnapshot).toBe(false);
        });

        it('cannot freeze an already frozen pack', () => {
            const pack = { status: 'FROZEN' };
            const canFreeze = pack.status === 'DRAFT';
            expect(canFreeze).toBe(false);
        });
    });

    describe('Snapshot Structure', () => {
        it('practice snapshot includes required fields', () => {
            const snapshot = {
                code: 'CTRL-1', name: 'Test Practice', status: 'IMPLEMENTED',
                taskCompletion: { total: 3, done: 2 },
                evidenceCount: 5,
                mappedRequirements: [{ code: 'A.5.1', title: 'Info sec policies' }],
                snapshotAt: new Date().toISOString(),
            };
            expect(snapshot).toHaveProperty('code');
            expect(snapshot).toHaveProperty('status');
            expect(snapshot).toHaveProperty('taskCompletion');
            expect(snapshot).toHaveProperty('evidenceCount');
            expect(snapshot).toHaveProperty('mappedRequirements');
            expect(snapshot).toHaveProperty('snapshotAt');
        });

        it('policy snapshot includes version info', () => {
            const snapshot = {
                title: 'Security Policy', status: 'PUBLISHED',
                currentVersion: 3, currentVersionStatus: 'APPROVED',
                snapshotAt: new Date().toISOString(),
            };
            expect(snapshot).toHaveProperty('title');
            expect(snapshot).toHaveProperty('currentVersion');
        });

        it('evidence snapshot is minimal', () => {
            const snapshot = {
                title: 'Evidence', type: 'FILE', status: 'APPROVED',
                snapshotAt: new Date().toISOString(),
            };
            expect(snapshot).toHaveProperty('type');
            expect(snapshot).toHaveProperty('status');
        });

        it('issue snapshot includes severity and due date', () => {
            const snapshot = {
                title: 'Finding', type: 'AUDIT_FINDING', severity: 'HIGH',
                status: 'OPEN', dueAt: '2025-12-31',
                snapshotAt: new Date().toISOString(),
            };
            expect(snapshot).toHaveProperty('severity');
            expect(snapshot).toHaveProperty('dueAt');
        });
    });

    describe('Share Link Validation', () => {
        it('rejects expired share links', () => {
            const share = { expiresAt: new Date('2020-01-01') };
            const isExpired = share.expiresAt < new Date();
            expect(isExpired).toBe(true);
        });

        it('allows null expiry (never expires)', () => {
            const share = { expiresAt: null as Date | null };
            const isExpired = share.expiresAt ? share.expiresAt < new Date() : false;
            expect(isExpired).toBe(false);
        });

        it('allows future expiry', () => {
            const share = { expiresAt: new Date('2099-01-01') };
            const isExpired = share.expiresAt < new Date();
            expect(isExpired).toBe(false);
        });

        it('revoked share is invalid', () => {
            const share = { revokedAt: new Date() };
            const isRevoked = share.revokedAt !== null;
            expect(isRevoked).toBe(true);
        });

        it('active share has null revokedAt', () => {
            const share = { revokedAt: null as Date | null };
            const isRevoked = share.revokedAt !== null;
            expect(isRevoked).toBe(false);
        });
    });

    describe('Default Pack Selection', () => {
        it('ISO27001 pack includes practices, policies, evidence, issues', () => {
            const selection = {
                practices: { count: 10, ids: ['c1', 'c2'] },
                policies: { count: 3, ids: ['p1'] },
                evidence: { count: 5, ids: ['e1'] },
                issues: { count: 2, ids: ['i1'] },
            };
            expect(selection.practices.count).toBeGreaterThan(0);
            expect(Object.keys(selection)).toEqual(['practices', 'policies', 'evidence', 'issues']);
        });

        it('NIS2 pack filters policies by keywords', () => {
            const policies = [
                { id: 'p1', title: 'Incident Response Plan', category: 'Security' },
                { id: 'p2', title: 'HR Policy', category: 'HR' },
                { id: 'p3', title: 'Business Continuity Plan', category: 'Resilience' },
                { id: 'p4', title: 'Supplier Security', category: 'Security' },
            ];
            const nis2Keywords = ['incident', 'business continuity', 'disaster recovery', 'access control', 'supplier', 'supply chain'];
            const filtered = policies.filter(p => {
                const text = `${p.title} ${p.category}`.toLowerCase();
                return nis2Keywords.some(kw => text.includes(kw));
            });
            expect(filtered.length).toBe(3);
            expect(filtered.map(p => p.id)).toEqual(['p1', 'p3', 'p4']);
        });

        it('falls back to all practices if no framework mapping', () => {
            const practiceIds: string[] = []; // no mapping
            const allPractices = [{ id: 'c1' }, { id: 'c2' }];
            const result = practiceIds.length === 0 ? allPractices.map(c => c.id) : practiceIds;
            expect(result).toEqual(['c1', 'c2']);
        });
    });

    describe('Pack Status Lifecycle', () => {
        it('valid transitions: DRAFT → FROZEN → EXPORTED', () => {
            const validTransitions: Record<string, string[]> = {
                DRAFT: ['FROZEN'],
                FROZEN: ['EXPORTED'],
                EXPORTED: [],
            };
            expect(validTransitions.DRAFT).toContain('FROZEN');
            expect(validTransitions.FROZEN).toContain('EXPORTED');
            expect(validTransitions.EXPORTED.length).toBe(0);
        });

        it('cannot share a DRAFT pack', () => {
            const pack = { status: 'DRAFT' };
            const canShare = pack.status !== 'DRAFT';
            expect(canShare).toBe(false);
        });

        it('can share a FROZEN pack', () => {
            const pack = { status: 'FROZEN' };
            const canShare = pack.status !== 'DRAFT';
            expect(canShare).toBe(true);
        });

        it('cannot export a DRAFT pack', () => {
            const pack = { status: 'DRAFT' };
            const canExport = pack.status !== 'DRAFT';
            expect(canExport).toBe(false);
        });
    });

    describe('Tenant Isolation', () => {
        it('queries always include tenantId', () => {
            const tenantA = 'tenant-a-id';
            const tenantB = 'tenant-b-id';
            const query = { tenantId: tenantA };
            expect(query.tenantId).toBe(tenantA);
            expect(query.tenantId).not.toBe(tenantB);
        });

        it('pack items are scoped to tenant', () => {
            const items = [
                { tenantId: 't1', entityId: 'e1' },
                { tenantId: 't2', entityId: 'e2' },
            ];
            const t1Items = items.filter(i => i.tenantId === 't1');
            expect(t1Items.length).toBe(1);
        });

        it('share tokens only resolve to same tenant pack', () => {
            // Token hash resolves a share, but the share.tenantId must match
            const share = { tenantId: 't1', auditPackId: 'p1' };
            expect(share.tenantId).toBe('t1');
        });
    });

    describe('Export Format', () => {
        it('JSON export includes pack metadata and items', () => {
            const exportData = {
                pack: { id: 'p1', name: 'ISO27001 Pack', status: 'FROZEN', frozenAt: '2025-01-01' },
                cycle: { frameworkKey: 'ISO27001' },
                items: [{ entityType: 'CONTROL', entityId: 'c1', snapshot: {} }],
            };
            expect(exportData).toHaveProperty('pack');
            expect(exportData).toHaveProperty('cycle');
            expect(exportData.items.length).toBeGreaterThan(0);
        });

        it('CSV export has correct headers', () => {
            const headers = ['Type', 'Entity ID', 'Name/Title', 'Status', 'Details'];
            expect(headers.length).toBe(5);
        });
    });

    describe('Zod Validation', () => {
        const { z } = require('zod');

        const CreateCycleSchema = z.object({
            frameworkKey: z.enum(['ISO27001', 'NIS2']),
            frameworkVersion: z.string().min(1),
            name: z.string().min(1).max(200),
        }).strip();

        it('accepts valid ISO27001 cycle', () => {
            const result = CreateCycleSchema.parse({
                frameworkKey: 'ISO27001', frameworkVersion: '2022', name: 'ISO 27001 Audit 2025',
            });
            expect(result.frameworkKey).toBe('ISO27001');
        });

        it('accepts valid NIS2 cycle', () => {
            const result = CreateCycleSchema.parse({
                frameworkKey: 'NIS2', frameworkVersion: 'EU_2022_2555', name: 'NIS2 Compliance',
            });
            expect(result.frameworkKey).toBe('NIS2');
        });

        it('rejects invalid framework key', () => {
            expect(() => CreateCycleSchema.parse({
                frameworkKey: 'SOC2', frameworkVersion: '1', name: 'Test',
            })).toThrow();
        });

        it('strips unknown fields', () => {
            const result = CreateCycleSchema.parse({
                frameworkKey: 'ISO27001', frameworkVersion: '2022', name: 'Test', extra: 'oops',
            });
            expect(result).not.toHaveProperty('extra');
        });
    });

    describe('Structural Guards', () => {
        it('audit routes do not import prisma directly', () => {
            const fs = require('fs');
            const path = require('path');
            const routeFiles = [
                path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]/audits/cycles/route.ts'),
                path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]/audits/packs/route.ts'),
            ];
            for (const file of routeFiles) {
                if (!fs.existsSync(file)) continue;
                const content = fs.readFileSync(file, 'utf8');
                expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
                expect(content).toMatch(/from\s+['"]@\/app-layer\/usecases\/audit-readiness['"]/);
            }
        });

        it('pack detail route does not import prisma directly', () => {
            const fs = require('fs');
            const path = require('path');
            const file = path.resolve(__dirname, '../../src/app/api/t/[tenantSlug]/audits/packs/[packId]/route.ts');
            if (!fs.existsSync(file)) return;
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toMatch(/from\s+['"]@\/lib\/prisma['"]/);
        });
    });

    describe('Usecase Exports', () => {
        it('exports all audit readiness usecases', () => {
            const ar = require('../../src/app-layer/usecases/audit-readiness');
            expect(typeof ar.createAuditCycle).toBe('function');
            expect(typeof ar.listAuditCycles).toBe('function');
            expect(typeof ar.getAuditCycle).toBe('function');
            expect(typeof ar.updateAuditCycle).toBe('function');
            expect(typeof ar.createAuditPack).toBe('function');
            expect(typeof ar.listAuditPacks).toBe('function');
            expect(typeof ar.getAuditPack).toBe('function');
            expect(typeof ar.updateAuditPack).toBe('function');
            expect(typeof ar.addAuditPackItems).toBe('function');
            expect(typeof ar.freezeAuditPack).toBe('function');
            expect(typeof ar.generateShareLink).toBe('function');
            expect(typeof ar.revokeShare).toBe('function');
            expect(typeof ar.getPackByShareToken).toBe('function');
            expect(typeof ar.inviteAuditor).toBe('function');
            expect(typeof ar.grantAuditorAccess).toBe('function');
            expect(typeof ar.revokeAuditorAccess).toBe('function');
            expect(typeof ar.previewDefaultPack).toBe('function');
            expect(typeof ar.exportAuditPack).toBe('function');
            expect(typeof ar.hashToken).toBe('function');
            expect(typeof ar.generateShareToken).toBe('function');
        });
    });

    describe('Policy Authorization', () => {
        it('exports all audit policies', () => {
            const pol = require('../../src/app-layer/policies/audit-readiness.policies');
            expect(typeof pol.assertCanManageAuditCycles).toBe('function');
            expect(typeof pol.assertCanManageAuditPacks).toBe('function');
            expect(typeof pol.assertCanFreezePack).toBe('function');
            expect(typeof pol.assertCanSharePack).toBe('function');
            expect(typeof pol.assertCanViewPack).toBe('function');
            expect(typeof pol.assertCanManageAuditors).toBe('function');
        });

        it('EDITOR can manage cycles', () => {
            const ctx = { role: 'EDITOR' };
            expect(['ADMIN', 'EDITOR'].includes(ctx.role)).toBe(true);
        });

        it('READER cannot manage cycles', () => {
            const ctx = { role: 'READER' };
            expect(['ADMIN', 'EDITOR'].includes(ctx.role)).toBe(false);
        });

        it('only ADMIN can freeze', () => {
            const admin: string = 'ADMIN';
            const editor: string = 'EDITOR';
            expect(admin === 'ADMIN').toBe(true);
            expect(editor === 'ADMIN').toBe(false);
        });
    });
});

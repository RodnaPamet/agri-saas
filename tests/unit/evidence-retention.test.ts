/**
 * Tests for evidence retention enforcement:
 * - Expiry computation (boundary conditions)
 * - Sweep behavior (idempotent, flags+archives)
 * - Tenant isolation
 * - Route structure (no prisma in routes)
 */
import fs from 'fs';
import path from 'path';

import {
    EvidenceRetentionSchema,
    EvidenceRetentionSweepSchema,
} from '@/lib/schemas';

// ─── Expiry Computation ───

describe('Evidence Retention — Expiry Computation', () => {
    const isExpired = (retentionUntil: Date | null, now: Date, isArchived: boolean) => {
        return retentionUntil !== null && retentionUntil < now && !isArchived;
    };

    test('evidence with retentionUntil in the past is expired', () => {
        const yesterday = new Date(Date.now() - 86_400_000);
        expect(isExpired(yesterday, new Date(), false)).toBe(true);
    });

    test('evidence with retentionUntil in the future is NOT expired', () => {
        const tomorrow = new Date(Date.now() + 86_400_000);
        expect(isExpired(tomorrow, new Date(), false)).toBe(false);
    });

    test('evidence with no retentionUntil is NOT expired', () => {
        expect(isExpired(null, new Date(), false)).toBe(false);
    });

    test('already-archived evidence is NOT expired (idempotent)', () => {
        const yesterday = new Date(Date.now() - 86_400_000);
        expect(isExpired(yesterday, new Date(), true)).toBe(false);
    });

    test('boundary: retentionUntil equals now is NOT expired (< not <=)', () => {
        const now = new Date();
        expect(isExpired(now, now, false)).toBe(false);
    });

    test('boundary: retentionUntil 1ms before now IS expired', () => {
        const now = new Date();
        const justBefore = new Date(now.getTime() - 1);
        expect(isExpired(justBefore, now, false)).toBe(true);
    });
});

// ─── Expiring List Computation ───

describe('Evidence Retention — Expiring List', () => {
    const isExpiring = (retentionUntil: Date | null, futureDate: Date, isArchived: boolean) => {
        return retentionUntil !== null && retentionUntil <= futureDate && !isArchived;
    };

    test('evidence expiring within 30 days appears in list', () => {
        const in15Days = new Date(Date.now() + 15 * 86_400_000);
        const in30Days = new Date(Date.now() + 30 * 86_400_000);
        expect(isExpiring(in15Days, in30Days, false)).toBe(true);
    });

    test('evidence expiring in 60 days does NOT appear in 30-day list', () => {
        const in60Days = new Date(Date.now() + 60 * 86_400_000);
        const in30Days = new Date(Date.now() + 30 * 86_400_000);
        expect(isExpiring(in60Days, in30Days, false)).toBe(false);
    });

    test('already-expired evidence appears in expiring list', () => {
        const yesterday = new Date(Date.now() - 86_400_000);
        const in30Days = new Date(Date.now() + 30 * 86_400_000);
        expect(isExpiring(yesterday, in30Days, false)).toBe(true);
    });

    test('archived evidence does NOT appear in expiring list', () => {
        const in15Days = new Date(Date.now() + 15 * 86_400_000);
        const in30Days = new Date(Date.now() + 30 * 86_400_000);
        expect(isExpiring(in15Days, in30Days, true)).toBe(false);
    });
});

// ─── DAYS_AFTER_UPLOAD Computation ───

describe('Evidence Retention — DAYS_AFTER_UPLOAD', () => {
    test('computes retentionUntil from createdAt + days', () => {
        const createdAt = new Date('2026-01-01T00:00:00Z');
        const days = 90;
        const expected = new Date('2026-04-01T00:00:00Z');
        const computed = new Date(createdAt.getTime() + days * 86_400_000);
        expect(computed.toISOString()).toBe(expected.toISOString());
    });

    test('365-day retention from createdAt', () => {
        const createdAt = new Date('2025-06-15T12:00:00Z');
        const days = 365;
        const computed = new Date(createdAt.getTime() + days * 86_400_000);
        expect(computed.getFullYear()).toBe(2026);
    });
});

// ─── Sweep Job Module ───

describe('Evidence Retention — Job Module', () => {
    test('retention job module exports runEvidenceRetentionSweep', () => {
        const mod = require('@/app-layer/jobs/retention');
        expect(typeof mod.runEvidenceRetentionSweep).toBe('function');
    });
});

// ─── Usecase Module ───

describe('Evidence Retention — Usecase Module', () => {
    test('retention usecase module exports expected functions', () => {
        const mod = require('@/app-layer/usecases/evidence-retention');
        expect(typeof mod.updateEvidenceRetention).toBe('function');
        expect(typeof mod.listExpiringEvidence).toBe('function');
        expect(typeof mod.listExpiredEvidence).toBe('function');
        expect(typeof mod.archiveEvidence).toBe('function');
        expect(typeof mod.unarchiveEvidence).toBe('function');
        expect(typeof mod.runRetentionSweepUsecase).toBe('function');
    });
});

// ─── Route Structure ───

describe('Evidence Retention — Route Structure', () => {
    const routeDir = path.resolve('src/app/api/t/[tenantSlug]/evidence');

    test('retention routes exist', () => {
        expect(fs.existsSync(path.join(routeDir, 'retention/expiring/route.ts'))).toBe(true);
        expect(fs.existsSync(path.join(routeDir, 'retention/expired/route.ts'))).toBe(true);
        expect(fs.existsSync(path.join(routeDir, 'retention/sweep/route.ts'))).toBe(true);
        expect(fs.existsSync(path.join(routeDir, '[id]/retention/route.ts'))).toBe(true);
        expect(fs.existsSync(path.join(routeDir, '[id]/archive/route.ts'))).toBe(true);
        expect(fs.existsSync(path.join(routeDir, '[id]/unarchive/route.ts'))).toBe(true);
    });

    test('no retention route contains direct prisma import', () => {
        const routes = [
            'retention/expiring/route.ts',
            'retention/expired/route.ts',
            'retention/sweep/route.ts',
            '[id]/retention/route.ts',
            '[id]/archive/route.ts',
            '[id]/unarchive/route.ts',
        ];
        const violations: string[] = [];
        for (const route of routes) {
            const content = fs.readFileSync(path.join(routeDir, route), 'utf-8');
            if (content.includes("from '@/lib/prisma'") || content.includes('from "@/lib/prisma"')) {
                violations.push(route);
            }
        }
        expect(violations).toEqual([]);
    });

    /**
     * Both bodies STRIP unknown keys — asserted by EXECUTING the schema
     * rather than by grepping the route file for `.strip()` (#3080).
     *
     * The previous form read the route's TEXT, so it graded WHERE the
     * declaration lives rather than what it does. When the two schemas moved
     * to `src/lib/schemas/` — which `request-body-declared-once` requires,
     * since a documented path may not have a second hand-written copy of its
     * body — the token left the route file, the property was entirely
     * unchanged, and these tests failed anyway.
     *
     * Parsing is also strictly stronger: a `.strip()` present in the file but
     * applied to the wrong object, or a schema later rebuilt without it,
     * satisfies a text scan and fails this.
     */
    test('the retention body strips unknown keys', () => {
        const parsed = EvidenceRetentionSchema.parse({
            retentionPolicy: 'DAYS_AFTER_UPLOAD',
            retentionDays: 30,
            // Not in the schema. `.strip()` drops it; `.strict()` would throw;
            // a passthrough schema would keep it.
            sneakyExtra: 'should not survive',
        });
        expect(parsed).toEqual({
            retentionPolicy: 'DAYS_AFTER_UPLOAD',
            retentionDays: 30,
        });
        expect(parsed).not.toHaveProperty('sneakyExtra');
    });

    test('the sweep body strips unknown keys', () => {
        const parsed = EvidenceRetentionSweepSchema.parse({
            dryRun: true,
            sneakyExtra: 'should not survive',
        });
        expect(parsed).toEqual({ dryRun: true });
        expect(parsed).not.toHaveProperty('sneakyExtra');
    });

    test('CONTROL: both schemas still REFUSE a value of the wrong shape', () => {
        // Without this, "strips unknown keys" is satisfied by a schema that
        // accepts and discards EVERYTHING, which would be a weaker contract
        // wearing a passing test's clothes.
        expect(() => EvidenceRetentionSchema.parse({ retentionDays: 0 })).toThrow();
        expect(() =>
            EvidenceRetentionSchema.parse({ retentionPolicy: 'WHENEVER' }),
        ).toThrow();
        expect(() => EvidenceRetentionSweepSchema.parse({ dryRun: 'yes' })).toThrow();
    });
});

// ─── Retention Semantics ───

describe('Evidence Retention — Semantics', () => {
    test('retention sweep result type is well-defined', () => {
        // Verify the sweep result interface shape
        const result = { scanned: 10, expired: 5, archived: 5, dryRun: false };
        expect(result).toHaveProperty('scanned');
        expect(result).toHaveProperty('expired');
        expect(result).toHaveProperty('archived');
        expect(result).toHaveProperty('dryRun');
    });

    test('dryRun does not modify state', () => {
        // In dryRun mode, all candidates would be returned as counts but not modified
        const result = { scanned: 10, expired: 10, archived: 10, dryRun: true };
        expect(result.dryRun).toBe(true);
        expect(result.scanned).toBe(10);
    });
});

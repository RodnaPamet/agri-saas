/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/mapping.ts`.
 *
 * Roadmap Q1 — Compliance core. Cross-framework projection layer
 * that joins MappingRepository control rows with the YAML-backed
 * SOC2 / NIS2 catalogues into readiness views.
 *
 * Covers:
 *   - SOC2 readiness fold — controls joined to soc2Codes via mapping
 *     table, IMPLEMENTED counted, evidence (APPROVED-only) counted,
 *     coverage = round(implemented / total * 100).
 *   - NIS2 readiness fold — same shape, but nis2Codes and no
 *     evidence count.
 *   - Zero-coverage safety (coverage = 0 when no controls).
 *   - Read-gate enforcement.
 *
 * Also removes mapping.ts from EXEMPTIONS in the structural ratchet.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn({})),
}));

jest.mock('@/app-layer/repositories/MappingRepository', () => ({
    MappingRepository: {
        getControlsWithEvidence: jest.fn(),
    },
}));

jest.mock('@/app-layer/libraries', () => ({
    getSOC2Requirements: jest.fn(() => [
        { code: 'CC1.1', title: 'Demonstrates Commitment to Integrity' },
        { code: 'CC2.1', title: 'Internal Communication' },
    ]),
    getNIS2Requirements: jest.fn(() => [
        { code: 'NIS2-21.1', title: 'Risk Management' },
    ]),
    getFrameworkMappings: jest.fn(() => [
        { isoControlId: 'A.5.1', soc2Codes: ['CC1.1'], nis2Codes: ['NIS2-21.1'] },
        { isoControlId: 'A.5.2', soc2Codes: ['CC2.1'], nis2Codes: [] },
    ]),
}));

import { MappingRepository } from '@/app-layer/repositories/MappingRepository';
import { getFrameworkMappings } from '@/app-layer/usecases/mapping';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const readerCtx = makeRequestContext('READER');

describe('getFrameworkMappings — SOC2 fold', () => {
    it('joins controls to soc2Codes, counts IMPLEMENTED + APPROVED evidence, computes coverage %', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([
            { code: 'A.5.1', status: 'IMPLEMENTED', evidence: [{ status: 'APPROVED' }] },
            { code: 'A.5.1', status: 'IN_PROGRESS', evidence: [{ status: 'DRAFT' }] },
        ]);

        const res = await getFrameworkMappings(readerCtx);

        const cc1 = res.soc2.find((c: any) => c.code === 'CC1.1')!;
        expect(cc1.controlCount).toBe(2);
        expect(cc1.implementedCount).toBe(1);
        expect(cc1.evidenceCount).toBe(1);
        expect(cc1.coverage).toBe(50); // 1/2 implemented = 50%
    });

    it('returns 0 coverage when no controls map to a requirement (no division by zero)', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([]);

        const res = await getFrameworkMappings(readerCtx);

        const orphan = res.soc2.find((c: any) => c.code === 'CC1.1')!;
        expect(orphan.controlCount).toBe(0);
        expect(orphan.coverage).toBe(0);
    });

    it('counts only APPROVED evidence (DRAFT/SUBMITTED ignored)', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([
            { code: 'A.5.1', status: 'IMPLEMENTED', evidence: [
                { status: 'DRAFT' }, { status: 'SUBMITTED' }, { status: 'APPROVED' },
            ] },
        ]);

        const res = await getFrameworkMappings(readerCtx);
        const cc1 = res.soc2.find((c: any) => c.code === 'CC1.1')!;
        expect(cc1.evidenceCount).toBe(1);
    });
});

describe('getFrameworkMappings — NIS2 fold', () => {
    it('joins controls via nis2Codes (skipping mappings with empty nis2Codes)', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([
            { code: 'A.5.1', status: 'IMPLEMENTED', evidence: [] },
            { code: 'A.5.2', status: 'IMPLEMENTED', evidence: [] }, // soc2 only, skipped by NIS2
        ]);

        const res = await getFrameworkMappings(readerCtx);

        const nis = res.nis2.find((c: any) => c.code === 'NIS2-21.1')!;
        expect(nis.controlCount).toBe(1);
        expect(nis.implementedCount).toBe(1);
        expect(nis.coverage).toBe(100);
    });

    it('returns 0 coverage when no controls map', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([]);
        const res = await getFrameworkMappings(readerCtx);
        const nis = res.nis2.find((c: any) => c.code === 'NIS2-21.1')!;
        expect(nis.coverage).toBe(0);
    });
});

describe('getFrameworkMappings — return shape', () => {
    it('returns { soc2, nis2, mappings } at the top level', async () => {
        (MappingRepository.getControlsWithEvidence as jest.Mock).mockResolvedValue([]);
        const res = await getFrameworkMappings(readerCtx);

        expect(res).toHaveProperty('soc2');
        expect(res).toHaveProperty('nis2');
        expect(res).toHaveProperty('mappings');
        expect(res.mappings).toHaveLength(2);
    });

    it('rejects when caller lacks read permission', async () => {
        const noReadCtx = makeRequestContext('READER', {
            permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        await expect(getFrameworkMappings(noReadCtx)).rejects.toBeDefined();
    });
});

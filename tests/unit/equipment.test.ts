/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Coverage for the equipment read usecase.
 *
 * `listEquipment` is a thin authorized read — it asserts canRead, then
 * delegates inside the tenant context (RLS-bound). Since the `Equipment`
 * merge that delegate is `AssetRepository.listMachines`, NOT
 * `JournalRepository.listEquipment`: machines live in `Asset` now.
 * Mocks the db-context + repository; uses the REAL `assertCanRead` via
 * the role on the RequestContext so the read gate is exercised for real.
 *
 * Also satisfies the usecase-test-coverage guardrail (every usecase file
 * must be imported by a test).
 */

const mockDb = {} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/repositories/AssetRepository', () => ({
    AssetRepository: { listMachines: jest.fn() },
}));

import { AssetRepository } from '@/app-layer/repositories/AssetRepository';
import { listEquipment } from '@/app-layer/usecases/equipment';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('listEquipment', () => {
    it('returns the repository rows for a reader, scoped to the tenant context', async () => {
        const rows = [
            { id: 'ast-1', name: 'John Deere 6155R', category: 'TRACTOR', make: 'John Deere', model: '6155R' },
            { id: 'ast-2', name: 'Boom sprayer', category: 'IMPLEMENT', make: null, model: null },
        ];
        (AssetRepository.listMachines as jest.Mock).mockResolvedValue(rows);

        const ctx = makeRequestContext('READER');
        await expect(listEquipment(ctx)).resolves.toBe(rows);
        expect(AssetRepository.listMachines).toHaveBeenCalledWith(mockDb, ctx);
    });

    it('an EDITOR (canRead) also passes the read gate', async () => {
        (AssetRepository.listMachines as jest.Mock).mockResolvedValue([]);
        const ctx = makeRequestContext('EDITOR');
        await expect(listEquipment(ctx)).resolves.toEqual([]);
        expect(AssetRepository.listMachines).toHaveBeenCalledTimes(1);
    });

    it('reads the ASSET register, not the retired Equipment table', async () => {
        // The merge's whole point: this read used to hit a table with no
        // write path, so both equipment pickers were permanently empty.
        // If a future refactor points it back at a journal-side delegate,
        // the pickers silently go blank again — hence the explicit
        // assertion on WHICH repository serves it.
        (AssetRepository.listMachines as jest.Mock).mockResolvedValue([{ id: 'ast-1' }]);
        const ctx = makeRequestContext('READER');
        const result = await listEquipment(ctx);

        expect(result).toEqual([{ id: 'ast-1' }]);
        expect(AssetRepository.listMachines).toHaveBeenCalledTimes(1);
    });
});

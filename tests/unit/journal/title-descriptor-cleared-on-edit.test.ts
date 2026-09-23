/**
 * A person editing the title takes the entry over, and the server's
 * descriptor must go with it (#1073).
 *
 * `titleKey` is not decoration: it exists so a reader can re-render the title
 * in its own language, which means a reader that resolves it PREFERS it to
 * the stored string. Leave it on a row whose title a person has rewritten and
 * that preference silently re-renders the operator's correction away — the
 * edit appears to save, the list shows the old machine text, and nothing
 * errors.
 *
 * The narrowness is the other half. Only a TITLE edit clears it: changing an
 * entry's notes, date or status does not make its auto-composed title less
 * accurate, and clearing on any edit would strip the descriptor from rows
 * that still deserve one.
 */
const mockDb = {
    logEntry: { updateMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
    __esModule: true,
}));

const getById = jest.fn();
const updateLogEntryRepo = jest.fn(async (..._a: unknown[]) => ({
    id: 'e1', type: 'INPUT_APPLICATION', title: 't', status: 'DONE',
}));
jest.mock('../../../src/app-layer/repositories/JournalRepository', () => ({
    JournalRepository: {
        getById: (...a: unknown[]) => getById(...a),
        updateLogEntry: (...a: unknown[]) => updateLogEntryRepo(...a),
        validLocationIds: jest.fn(async () => new Set<string>()),
        validEquipmentIds: jest.fn(async () => new Set<string>()),
        validParcelIds: jest.fn(async () => new Set<string>()),
    },
}));
jest.mock('../../../src/app-layer/repositories/FileRepository', () => ({ FileRepository: {} }));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../../src/app-layer/automation', () => ({ emitAutomationEvent: jest.fn() }));
jest.mock('../../../src/app-layer/usecases/inventory', () => ({ recordHarvestLot: jest.fn() }));
jest.mock('../../../src/app-layer/usecases/yield-record', () => ({ recordYieldFromHarvest: jest.fn() }));
jest.mock('../../../src/app-layer/usecases/crop-planning', () => ({ advancePlantingStatusForLinks: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (v: string) => v, sanitizeRichTextHtml: (v: string) => v,
}));
jest.mock('@/lib/observability', () => ({
    traceAgUsecase: (_n: string, _c: unknown, fn: () => unknown) => fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { updateLogEntry } from '@/app-layer/usecases/journal';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { tenantId: 'tenant-1', userId: 'u1' });
const EXISTING = {
    id: 'e1', tenantId: 'tenant-1', title: 'МАП 11-52-0 — 15655-19',
    titleKey: 'journal.autoTitle.inputApplication',
    type: 'INPUT_APPLICATION', status: 'DONE',
};

/**
 * The input the usecase handed the repository on the last call.
 *
 * Positional rather than named because the repository takes it that way. The
 * fallback is not defensive padding — it is what makes the mutation proof
 * meaningful: if this read the WRONG argument the `toBeUndefined()`
 * assertions would pass vacuously, which is exactly what mutation B below
 * rules out by flipping them red.
 */
function lastRepoInput(): Record<string, unknown> {
    const call = updateLogEntryRepo.mock.calls.at(-1) ?? [];
    return (call[3] ?? call[2]) as Record<string, unknown>;
}

beforeEach(() => {
    jest.clearAllMocks();
    getById.mockResolvedValue(EXISTING);
    mockDb.logEntry.updateMany.mockResolvedValue({ count: 1 });
});

describe('editing the title hands the entry to the operator', () => {
    it('clears the descriptor when the title changes', async () => {
        await updateLogEntry(CTX, 'e1', { title: 'Коригирана доза' });
        const input = lastRepoInput();
        // null CLEARS. undefined would leave the stale descriptor in place,
        // which is the whole defect.
        expect(input.titleKey).toBeNull();
        expect(input.titleParams).toBeNull();
    });

    it('leaves the descriptor alone when the title is untouched', async () => {
        await updateLogEntry(CTX, 'e1', { notes: '<p>вятър 3 м/с</p>' });
        const input = lastRepoInput();
        // undefined means "do not write this column" — an auto-composed title
        // is not made less accurate by someone recording the wind speed.
        expect(input.titleKey).toBeUndefined();
        expect(input.titleParams).toBeUndefined();
    });

    it('clears even when the new title is identical to the old', async () => {
        // The operator retyped it, so they own it now. Comparing strings to
        // decide ownership would make the outcome depend on what they typed
        // rather than on whether they typed.
        await updateLogEntry(CTX, 'e1', { title: EXISTING.title });
        expect(lastRepoInput().titleKey).toBeNull();
    });

    it('a date-only edit keeps the descriptor', async () => {
        await updateLogEntry(CTX, 'e1', { occurredAt: '2026-07-20' });
        expect(lastRepoInput().titleKey).toBeUndefined();
    });
});

/**
 * A PESTICIDE cannot be stored without the two fields its register row needs
 * (#1078).
 *
 * `quarantinePeriodDays` fills column 8 of the ХИМИЧНИ ОБРАБОТКИ table and
 * the earliest-harvest date in column 9; `pppRegistrationNo` is what makes
 * the trade name in column 4 checkable. A pesticide missing them cannot
 * produce a complete ДНЕВНИК, so storing one guarantees a bad filing later.
 *
 * The reason this is not a route-schema refinement is the UPDATE case. The
 * web's product form sends every field on edit, so clearing a registration
 * number is an ordinary thing a form can do — a guard on create alone would
 * be one PATCH away from nothing. And the update check runs against the
 * MERGED state, because a partial edit that omits a field must not be read as
 * clearing it.
 */
const mockDb = {
    item: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    unit: { findUnique: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(), assertCanAdmin: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: (v: string) => v, sanitizeRichTextHtml: (v: string) => v,
}));

import { createItem, updateItem } from '@/app-layer/usecases/catalog';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR');
const VALID_PESTICIDE = {
    name: 'Karate Zeon 5 CS',
    category: 'PESTICIDE' as const,
    defaultUnitId: 'unit-l',
    pppRegistrationNo: '01234-ПРЗ',
    quarantinePeriodDays: 21,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.unit.findUnique.mockResolvedValue({ id: 'unit-l' });
    mockDb.item.create.mockResolvedValue({ id: 'i1', name: VALID_PESTICIDE.name });
    mockDb.item.update.mockResolvedValue({ id: 'i1' });
});

describe('creating a product', () => {
    it('accepts a pesticide carrying both fields', async () => {
        await expect(createItem(CTX, VALID_PESTICIDE)).resolves.toBeDefined();
        expect(mockDb.item.create).toHaveBeenCalled();
    });

    it('refuses a pesticide with no registration number', async () => {
        await expect(
            createItem(CTX, { ...VALID_PESTICIDE, pppRegistrationNo: null }),
        ).rejects.toThrow(/registration number/i);
        expect(mockDb.item.create).not.toHaveBeenCalled();
    });

    it('refuses a blank registration number, not just a null one', async () => {
        // The web sends `pPppRegNo.trim() || null`, but a different client may
        // send whitespace. Both are "absent" for a regulated column.
        await expect(
            createItem(CTX, { ...VALID_PESTICIDE, pppRegistrationNo: '   ' }),
        ).rejects.toThrow(/registration number/i);
    });

    it('refuses a pesticide with no quarantine period', async () => {
        await expect(
            createItem(CTX, { ...VALID_PESTICIDE, quarantinePeriodDays: null }),
        ).rejects.toThrow(/quarantine/i);
    });

    it('accepts a quarantine period of ZERO', async () => {
        // 0 days is a real value — some products have no waiting period — and
        // a `!value` check would have rejected it. The guard tests for null.
        await expect(
            createItem(CTX, { ...VALID_PESTICIDE, quarantinePeriodDays: 0 }),
        ).resolves.toBeDefined();
    });

    it('leaves other categories unconstrained', async () => {
        // A fertiliser has no ЗЗР registration; demanding one would invent a
        // rule the form does not have.
        await expect(
            createItem(CTX, {
                name: 'Карбамид 46%',
                category: 'FERTILIZER',
                defaultUnitId: 'unit-l',
            }),
        ).resolves.toBeDefined();
    });
});

describe('editing a product', () => {
    const STORED = {
        id: 'i1',
        category: 'PESTICIDE',
        pppRegistrationNo: '01234-ПРЗ',
        quarantinePeriodDays: 21,
    };

    it('refuses an edit that CLEARS the registration number', async () => {
        // The window a create-only guard would have left open.
        mockDb.item.findFirst.mockResolvedValue(STORED);
        await expect(
            updateItem(CTX, 'i1', { pppRegistrationNo: null }),
        ).rejects.toThrow(/registration number/i);
        expect(mockDb.item.update).not.toHaveBeenCalled();
    });

    it('allows a partial edit that does not touch them', async () => {
        // `undefined` means "leave alone". Checking the patch instead of the
        // merged state would reject every ordinary edit of a valid pesticide.
        mockDb.item.findFirst.mockResolvedValue(STORED);
        await expect(updateItem(CTX, 'i1', { name: 'Karate Zeon 5 CS ' })).resolves.toBeDefined();
        expect(mockDb.item.update).toHaveBeenCalled();
    });

    it('refuses re-categorising an incomplete product INTO pesticide', async () => {
        // The other direction into the same bad state.
        mockDb.item.findFirst.mockResolvedValue({
            id: 'i2', category: 'OTHER', pppRegistrationNo: null, quarantinePeriodDays: null,
        });
        await expect(updateItem(CTX, 'i2', { category: 'PESTICIDE' })).rejects.toThrow(
            /registration number|quarantine/i,
        );
    });

    it('allows re-categorising AWAY from pesticide', async () => {
        mockDb.item.findFirst.mockResolvedValue({
            id: 'i3', category: 'PESTICIDE', pppRegistrationNo: null, quarantinePeriodDays: null,
        });
        await expect(updateItem(CTX, 'i3', { category: 'OTHER' })).resolves.toBeDefined();
    });
});

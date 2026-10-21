/**
 * Loading the БАБХ ПРЗ register (#2077).
 *
 * Tested this hard because of what the data is used for. A dose from this
 * table is suggested to a farmer who may transcribe it onto a ДНЕВНИК page
 * that БАБХ can inspect, and the read takes the LATEST import — so every way
 * this write can half-succeed is a way the national register becomes quietly
 * wrong rather than visibly broken.
 *
 * Each `it()` names the production break it catches.
 */
import { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';
import type { ParsedPppRegister, ParsedPppEntry } from '@/lib/agro/ppp-register-parse';

// ── Seams ────────────────────────────────────────────────────────────

/** Call order, which is the whole point of two of the tests below. */
const calls: string[] = [];

const imports = {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
};
const entries = { createMany: jest.fn(), count: jest.fn() };
const mockDb = {
    pppRegisterImport: imports,
    pppRegisterEntry: entries,
} as unknown as PrismaTx;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: PrismaTx) => unknown) => fn(mockDb),
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEvent(...a),
}));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: unknown[]) => assertPlatformSupport(...a),
}));

import {
    importPppRegister,
    describePppRegister,
    ENTRY_INSERT_CHUNK,
    MAX_CELL_LENGTH,
    MAX_PESTS_PER_ENTRY,
} from '@/app-layer/usecases/ppp-register-admin';

const ctx = makeRequestContext('ADMIN', { userId: 'u_support' });

function entry(over: Partial<ParsedPppEntry> = {}): ParsedPppEntry {
    return {
        crop: 'Пшеница',
        productName: 'Карате Зеон',
        pppRegistrationNo: '1234-ПРЗ',
        pests: ['Листни въшки'],
        doseMin: 1.5,
        doseMax: 2,
        doseUnit: 'л/дка',
        quarantinePeriodDays: 30,
        withdrawn: false,
        ...over,
    };
}

function parsed(over: Partial<ParsedPppRegister> = {}): ParsedPppRegister {
    return {
        entries: [entry()],
        skippedRows: 0,
        unparsedDoses: 0,
        headers: ['Култура', 'Продукт', 'Доза'],
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS, so a test that
    // makes the gate throw would otherwise poison every test after it.
    assertPlatformSupport.mockReset();
    calls.length = 0;
    imports.findFirst.mockImplementation(async () => {
        calls.push('findFirst');
        return null;
    });
    imports.create.mockImplementation(async () => {
        calls.push('create');
        return { id: 'imp_1' };
    });
    imports.update.mockImplementation(async () => {
        calls.push('update');
        return {};
    });
    entries.createMany.mockImplementation(async () => {
        calls.push('createMany');
        return { count: 0 };
    });
    logEvent.mockImplementation(async () => {
        calls.push('logEvent');
    });
});

describe('the platform gate', () => {
    // Break: `admin.manage` resolves from Role, so the OWNER of EVERY farm
    // holds it. Without the slug check, any farm's owner could replace the
    // national register every other farm reads.
    it('is asserted before the database is touched', async () => {
        assertPlatformSupport.mockImplementation(() => {
            throw new Error('not the platform tenant');
        });
        await expect(importPppRegister(ctx, { parsed: parsed(), sourceName: 'r.csv' })).rejects.toThrow(
            'not the platform tenant',
        );
        expect(calls).toEqual([]);
    });

    it('guards the read as well as the write', async () => {
        assertPlatformSupport.mockImplementation(() => {
            throw new Error('not the platform tenant');
        });
        await expect(describePppRegister(ctx)).rejects.toThrow('not the platform tenant');
    });
});

describe('refusals that protect the live register', () => {
    // Break: an empty or truncated export replaces a good register, and every
    // lookup then misses — which renders as "no product is approved for this
    // crop", a statement about Bulgarian law a blank spreadsheet cannot make.
    it('refuses an import with no entries, and writes nothing', async () => {
        await expect(
            importPppRegister(ctx, {
                parsed: parsed({ entries: [], skippedRows: 7 }),
                sourceName: 'empty.csv',
            }),
        ).rejects.toThrow(/Refusing to replace the live register with an empty one/);
        expect(imports.create).not.toHaveBeenCalled();
        expect(entries.createMany).not.toHaveBeenCalled();
    });

    it('names the headers and the skipped count in that refusal', async () => {
        await expect(
            importPppRegister(ctx, {
                parsed: parsed({ entries: [], skippedRows: 7 }),
                sourceName: 'empty.csv',
            }),
        ).rejects.toThrow(/Култура \| Продукт \| Доза[\s\S]*7 row/);
    });

    // Break: the realistic parser failure is binding `productName` to a
    // conditions-of-use column. The rows all look fine individually; the tell
    // is their LENGTH. Dropping them row-by-row would ship a register with an
    // arbitrary subset missing, so the whole import is refused.
    it('refuses a cell long enough to mean a column was mis-bound', async () => {
        const long = 'х'.repeat(MAX_CELL_LENGTH + 1);
        await expect(
            importPppRegister(ctx, {
                parsed: parsed({ entries: [entry(), entry({ productName: long })] }),
                sourceName: 'r.csv',
            }),
        ).rejects.toThrow(new RegExp(`${MAX_CELL_LENGTH + 1} characters long`));
        expect(imports.create).not.toHaveBeenCalled();
    });

    it('refuses a pest cell that is more likely prose', async () => {
        const many = Array.from({ length: MAX_PESTS_PER_ENTRY + 1 }, (_, i) => `вредител ${i}`);
        await expect(
            importPppRegister(ctx, {
                parsed: parsed({ entries: [entry({ pests: many })] }),
                sourceName: 'r.csv',
            }),
        ).rejects.toThrow(new RegExp(`lists ${MAX_PESTS_PER_ENTRY + 1} pests`));
        expect(imports.create).not.toHaveBeenCalled();
    });
});

describe('the snapshot is only live once it is whole', () => {
    // Break: THE one that matters. The read takes the latest import, so an
    // upload that dies part-way would become the live national register with
    // rows missing — and a miss is indistinguishable from "not approved".
    // `completedAt` is stamped last, so a half-written import is invisible by
    // construction rather than by hoping the transaction was short enough.
    it('stamps completedAt only after every entry chunk is written', async () => {
        const many = Array.from({ length: ENTRY_INSERT_CHUNK * 2 + 1 }, () => entry());
        await importPppRegister(ctx, { parsed: parsed({ entries: many }), sourceName: 'r.csv' });

        expect(calls).toEqual([
            'findFirst',
            'create',
            'createMany',
            'createMany',
            'createMany',
            'update',
            'logEvent',
        ]);
        // And the create must NOT pre-stamp it — an `update` in the right
        // place is no protection if the row was born complete.
        expect(imports.create.mock.calls[0]![0].data).not.toHaveProperty('completedAt');
        expect(imports.update.mock.calls[0]![0].data.completedAt).toBeInstanceOf(Date);
    });

    it('chunks the entry insert rather than sending one statement', async () => {
        const many = Array.from({ length: ENTRY_INSERT_CHUNK + 5 }, () => entry());
        await importPppRegister(ctx, { parsed: parsed({ entries: many }), sourceName: 'r.csv' });
        expect(entries.createMany).toHaveBeenCalledTimes(2);
        expect(entries.createMany.mock.calls[0]![0].data).toHaveLength(ENTRY_INSERT_CHUNK);
        expect(entries.createMany.mock.calls[1]![0].data).toHaveLength(5);
    });

    // Break: an INCOMPLETE import counted as the previous one would compare
    // the new upload against a number that was never live.
    it('reads the previous count from the latest COMPLETED import only', async () => {
        imports.findFirst.mockImplementation(async () => {
            calls.push('findFirst');
            return { entryCount: 4100 };
        });
        const result = await importPppRegister(ctx, {
            parsed: parsed(),
            sourceName: 'r.csv',
        });
        expect(imports.findFirst.mock.calls[0]![0].where).toEqual({ completedAt: { not: null } });
        // Printed beside the new count so a truncated export is visible in the
        // response rather than looking like a success.
        expect(result).toMatchObject({ entryCount: 1, previousEntryCount: 4100 });
    });
});

describe('what is written', () => {
    it('stores doses as Decimals and keeps a withdrawn row', async () => {
        await importPppRegister(ctx, {
            parsed: parsed({
                entries: [entry({ withdrawn: true, doseMin: 0.1, doseMax: 0.1 })],
            }),
            sourceName: 'r.csv',
        });
        const row = entries.createMany.mock.calls[0]![0].data[0];
        expect(row.doseMin).toBeInstanceOf(Prisma.Decimal);
        expect(row.doseMin.toString()).toBe('0.1');
        // Kept, NOT dropped at import: the withdrawal is a fact the product
        // can state ("this was approved and no longer is"), which is more
        // useful than the row's silent absence.
        expect(row.withdrawn).toBe(true);
    });

    it('passes a null dose through rather than defaulting it', async () => {
        await importPppRegister(ctx, {
            parsed: parsed({ entries: [entry({ doseMin: null, doseMax: null })] }),
            sourceName: 'r.csv',
        });
        const row = entries.createMany.mock.calls[0]![0].data[0];
        expect(row.doseMin).toBeNull();
        expect(row.doseMax).toBeNull();
    });

    it('records the operator as an opaque id', async () => {
        await importPppRegister(ctx, { parsed: parsed(), sourceName: 'r.csv' });
        expect(imports.create.mock.calls[0]![0].data).toMatchObject({
            importedById: 'u_support',
            sourceName: 'r.csv',
            entryCount: 1,
        });
    });

    it('audits both counts, so a shrinking register is on the record', async () => {
        imports.findFirst.mockResolvedValue({ entryCount: 4100 });
        await importPppRegister(ctx, {
            parsed: parsed({ entries: [entry(), entry({ withdrawn: true })] }),
            sourceName: 'register-2026.csv',
        });
        const payload = logEvent.mock.calls[0]![2];
        expect(payload.action).toBe('PPP_REGISTER_IMPORT');
        expect(payload.detailsJson).toMatchObject({
            category: 'entity_lifecycle',
            operation: 'created',
            after: {
                entryCount: 2,
                previousEntryCount: 4100,
                withdrawnCount: 1,
                sourceName: 'register-2026.csv',
            },
        });
    });
});

describe('describePppRegister', () => {
    // Break: reporting the import row's own `entryCount` back as proof it was
    // stored would be circular — the number came from the parse, not the
    // table. Counting the rows is what makes the two agreeing evidence.
    it('counts stored entries rather than trusting the import row', async () => {
        imports.findFirst.mockResolvedValue({
            id: 'imp_1',
            importedAt: new Date('2026-10-21T00:00:00Z'),
            sourceName: 'r.csv',
            entryCount: 4100,
        });
        imports.count.mockResolvedValue(0);
        entries.count.mockResolvedValueOnce(4100).mockResolvedValueOnce(12);

        const state = await describePppRegister(ctx);
        expect(state.live).toMatchObject({
            entryCount: 4100,
            storedEntries: 4100,
            withdrawnCount: 12,
        });
    });

    it('reports no live register when nothing has completed', async () => {
        imports.findFirst.mockResolvedValue(null);
        imports.count.mockResolvedValue(2);
        await expect(describePppRegister(ctx)).resolves.toEqual({
            live: null,
            incompleteImports: 2,
        });
    });
});

/**
 * Agro calendar stage 2 — writing and clearing overrides (#3095). The origin
 * is derived from the window's id, the loader's rules hold for overrides, a
 * citation is never accepted, and the calendar route merges what is live.
 */
const findMany = jest.fn();
const findFirst = jest.fn();
const update = jest.fn();
const updateMany = jest.fn();
const create = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        agroCalendarOverride: {
            findMany: (...a: unknown[]) => findMany(...a),
            findFirst: (...a: unknown[]) => findFirst(...a),
            update: (...a: unknown[]) => update(...a),
        },
        $transaction: async (fn: (tx: unknown) => unknown) =>
            fn({
                agroCalendarOverride: {
                    updateMany: (...a: unknown[]) => updateMany(...a),
                    create: (...a: unknown[]) => create(...a),
                },
            }),
    },
}));
const append = jest.fn();
jest.mock('@/lib/audit/platform-audit-writer', () => ({
    appendPlatformAuditEntry: (...a: unknown[]) => append(...a),
}));

import {
    clearCalendarOverride,
    loadLiveCalendarOverrides,
    setCalendarOverride,
} from '@/app-layer/usecases/agro-calendar-overrides';
import { calendarFor } from '@/lib/agro/calendar/load';

const ME = { kind: 'user', userId: 'u-admin' } as const;
const WHEAT = {
    id: 'wheat-bread.sow.optimal.north',
    kind: 'sowing',
    band: 'optimal',
    region: 'north',
    from: '09-20',
    to: '10-05',
};

beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue({ createdAt: new Date('2026-11-17T20:00:00Z') });
    append.mockResolvedValue({});
});

const code = async (p: Promise<unknown>) => {
    try {
        await p;
        return 'resolved';
    } catch (e) {
        return (e as { code?: string }).code ?? String(e);
    }
};

describe('setting an override', () => {
    it('a cited window id is a CORRECTION, replacing any live one, and audited', async () => {
        const r = await setCalendarOverride({ cropKey: 'wheat-bread', window: WHEAT, basis: { bg: '  НССЗ, Плевен  ' } }, ME);
        expect(r).toMatchObject({ origin: 'corrected', windowId: WHEAT.id, basis: { bg: 'НССЗ, Плевен' }, authorRef: 'user:u-admin' });
        expect(updateMany).toHaveBeenCalledWith({ where: { windowId: WHEAT.id, clearedAt: null }, data: { clearedAt: expect.any(Date) } });
        expect(create.mock.calls[0][0].data).toMatchObject({ origin: 'CORRECTED', cropKey: 'wheat-bread', basisBg: 'НССЗ, Плевен' });
        expect(append).toHaveBeenCalledWith(expect.objectContaining({ scope: 'agro-calendar', action: 'AGRO_CALENDAR_OVERRIDE_SET' }));
    });

    it('a new id is an ADDITION', async () => {
        const r = await setCalendarOverride(
            { cropKey: 'wheat-bread', window: { ...WHEAT, id: 'wheat-bread.sow.agrent.extra' }, basis: { bg: 'НССЗ' } },
            ME,
        );
        expect(r.origin).toBe('added');
        expect(create.mock.calls[0][0].data.origin).toBe('ADDED');
    });

    it('refuses: another crop\'s window id, a sowing window with no band, a blank basis, a citation, an unknown crop', async () => {
        expect(await code(setCalendarOverride({ cropKey: 'barley', window: WHEAT, basis: { bg: 'x' } }, ME)))
            .toBe('AGRO_CALENDAR_WINDOW_OF_ANOTHER_CROP');
        const { band: _band, ...noBand } = WHEAT;
        expect(await code(setCalendarOverride({ cropKey: 'wheat-bread', window: noBand, basis: { bg: 'x' } }, ME)))
            .toBe('AGRO_CALENDAR_SOWING_NEEDS_BAND');
        expect(await code(setCalendarOverride({ cropKey: 'wheat-bread', window: WHEAT, basis: { bg: '   ' } }, ME)))
            .toBe('AGRO_CALENDAR_BASIS_REQUIRED');
        expect(await code(setCalendarOverride({ cropKey: 'nope', window: WHEAT, basis: { bg: 'x' } }, ME)))
            .toBe('AGRO_CALENDAR_UNKNOWN_CROP');
        expect(await code(setCalendarOverride({ cropKey: 'wheat-bread', window: { ...WHEAT, from: '13-40' }, basis: { bg: 'x' } }, ME)))
            .toBe('AGRO_CALENDAR_INVALID_WINDOW');
        expect(create).not.toHaveBeenCalled();
    });

    it('a citation on the window is stripped, never stored — the basis replaces it', async () => {
        await setCalendarOverride(
            { cropKey: 'wheat-bread', window: { ...WHEAT, cite: { source: 'x', page: 1 } }, basis: { bg: 'НССЗ' } },
            ME,
        );
        expect(create.mock.calls[0][0].data.windowJson).not.toHaveProperty('cite');
    });

    it('a sick audit chain does not stop a correction', async () => {
        append.mockRejectedValue(new Error('chain down'));
        await expect(setCalendarOverride({ cropKey: 'wheat-bread', window: WHEAT, basis: { bg: 'x' } }, ME)).resolves.toBeTruthy();
    });
});

describe('clearing', () => {
    it('clears the live row and audits it', async () => {
        findFirst.mockResolvedValue({ id: 'o1', cropKey: 'wheat-bread', origin: 'CORRECTED' });
        await clearCalendarOverride(WHEAT.id, { kind: 'platform-key', generation: 'current' });
        expect(update).toHaveBeenCalledWith({ where: { id: 'o1' }, data: { clearedAt: expect.any(Date) } });
        expect(append).toHaveBeenCalledWith(expect.objectContaining({
            action: 'AGRO_CALENDAR_OVERRIDE_CLEARED',
            detailsJson: expect.objectContaining({ authorRef: 'platform-key:current' }),
        }));
    });

    it('is a 404 when nothing is live, so "cleared" is never claimed for nothing', async () => {
        findFirst.mockResolvedValue(null);
        expect(await code(clearCalendarOverride('nope', ME))).toBe('AGRO_CALENDAR_OVERRIDE_NOT_FOUND');
        expect(update).not.toHaveBeenCalled();
    });
});

describe('what the calendar serves', () => {
    it('merges a live correction: new dates, the basis, and no citation', async () => {
        findMany.mockResolvedValue([
            { windowId: WHEAT.id, cropKey: 'wheat-bread', origin: 'CORRECTED', windowJson: WHEAT, basisBg: 'НССЗ', basisEn: null },
        ]);
        const overrides = await loadLiveCalendarOverrides();
        const wheat = calendarFor({ region: 'north', crop: 'wheat-bread' }, overrides)[0];
        const w = wheat.windows.find((x) => x.id === WHEAT.id) as unknown as Record<string, unknown>;
        expect(w).toMatchObject({ from: '09-20', to: '10-05', origin: 'corrected', basis: { bg: 'НССЗ' } });
        expect(w.cites).toBeUndefined();
        // Control: with no overrides the cited window is served as published.
        const plain = calendarFor({ region: 'north', crop: 'wheat-bread' })[0].windows.find((x) => x.id === WHEAT.id);
        expect(plain).toMatchObject({ from: '09-25', to: '10-10' });
    });

    it('skips a stored window that no longer parses, serving the cited one', async () => {
        findMany.mockResolvedValue([
            { windowId: WHEAT.id, cropKey: 'wheat-bread', origin: 'CORRECTED', windowJson: { id: WHEAT.id }, basisBg: 'x', basisEn: null },
        ]);
        expect(await loadLiveCalendarOverrides()).toEqual([]);
    });
});

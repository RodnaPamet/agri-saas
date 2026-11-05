/**
 * Platform-support curation of the global promotions feed (#12).
 *
 * The invariants worth pinning are the ones that protect people outside this
 * console: a farmer must never see a half-finished ad, and an advertiser must
 * never lose the enquiries their campaign earned.
 */
export {};

const mockPromotion = {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
};
const mockCompany = { findUnique: jest.fn(), create: jest.fn() };
const mockLogEvent = jest.fn();

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ promotion: mockPromotion, company: mockCompany }),
}));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

import {
    derivePromotionStatus,
    createPromotion,
    updatePromotion,
    setPromotionPublished,
    deletePromotion,
} from '@/app-layer/usecases/promotion-admin';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN', {
    userId: 'support-1',
    tenantId: 'platform-t',
    tenantSlug: 'agrent-platform',
});

const NOW = new Date('2026-08-01T12:00:00.000Z');
const d = (s: string) => new Date(s);

beforeEach(() => {
    jest.clearAllMocks();
    mockPromotion.create.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
        id: 'p-1',
        ...a.data,
        company: { name: 'Syngenta' },
    }));
    mockPromotion.update.mockImplementation(async (a: { data: Record<string, unknown> }) => ({
        id: 'p-1',
        publishedAt: null,
        ...a.data,
        title: 'T',
        company: { name: 'Syngenta' },
    }));
});

describe('derivePromotionStatus — the two gates read together', () => {
    it('is DRAFT while unpublished, however the dates read', () => {
        // The window is wide open, but an unpublished row is still invisible.
        expect(
            derivePromotionStatus(
                { publishedAt: null, validFrom: d('2026-01-01'), validTo: d('2027-01-01') },
                NOW,
            ),
        ).toBe('DRAFT');
    });

    it('is SCHEDULED when published but the window has not opened', () => {
        expect(
            derivePromotionStatus(
                { publishedAt: d('2026-07-01'), validFrom: d('2026-09-01'), validTo: null },
                NOW,
            ),
        ).toBe('SCHEDULED');
    });

    it('is LIVE inside the window', () => {
        expect(
            derivePromotionStatus(
                { publishedAt: d('2026-07-01'), validFrom: d('2026-07-15'), validTo: d('2026-08-20') },
                NOW,
            ),
        ).toBe('LIVE');
    });

    it('is LIVE with no window at all', () => {
        expect(
            derivePromotionStatus({ publishedAt: d('2026-07-01'), validFrom: null, validTo: null }, NOW),
        ).toBe('LIVE');
    });

    it('is EXPIRED past the window', () => {
        expect(
            derivePromotionStatus(
                { publishedAt: d('2026-07-01'), validFrom: null, validTo: d('2026-07-20') },
                NOW,
            ),
        ).toBe('EXPIRED');
    });
});

describe('createPromotion', () => {
    it('always creates a DRAFT — nothing reaches a feed on save', async () => {
        await createPromotion(ctx, { companyId: 'c-1', title: 'Offer', category: 'seeds' });
        expect(mockPromotion.create.mock.calls[0][0].data.publishedAt).toBeNull();
    });

    it('find-or-creates the supplier when a name is typed instead of picked', async () => {
        mockCompany.findUnique.mockResolvedValue(null);
        mockCompany.create.mockResolvedValue({ id: 'c-new', name: 'Brand New Co' });

        await createPromotion(ctx, { companyName: 'Brand New Co', title: 'X', category: 'seeds' });

        expect(mockCompany.create).toHaveBeenCalledTimes(1);
        expect(mockPromotion.create.mock.calls[0][0].data.companyId).toBe('c-new');
    });

    it('reuses an existing supplier rather than duplicating it', async () => {
        mockCompany.findUnique.mockResolvedValue({ id: 'c-old', name: 'Syngenta' });

        await createPromotion(ctx, { companyName: '  syngenta ', title: 'X', category: 'seeds' });

        expect(mockCompany.create).not.toHaveBeenCalled();
        expect(mockPromotion.create.mock.calls[0][0].data.companyId).toBe('c-old');
    });

    it('sanitises the copy that will render cross-tenant', async () => {
        await createPromotion(ctx, {
            companyId: 'c-1',
            title: '<script>alert(1)</script>Deal',
            body: '<img src=x onerror=alert(1)>details',
            category: 'seeds',
        });
        const { data } = mockPromotion.create.mock.calls[0][0];
        expect(data.title).not.toContain('<script>');
        expect(data.body).not.toContain('onerror');
    });

    it('rejects an inverted campaign window', async () => {
        await expect(
            createPromotion(ctx, {
                companyId: 'c-1',
                title: 'X',
                category: 'seeds',
                validFrom: d('2026-09-01'),
                validTo: d('2026-08-01'),
            }),
        ).rejects.toThrow(/must not precede/i);
        expect(mockPromotion.create).not.toHaveBeenCalled();
    });

    it('audits the creation', async () => {
        await createPromotion(ctx, { companyId: 'c-1', title: 'Offer', category: 'seeds' });
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({ action: 'CREATE', entityType: 'Promotion' }),
        );
    });
});

describe('updatePromotion', () => {
    it('validates the window against the STORED value on a partial edit', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            validFrom: d('2026-09-01'),
            validTo: null,
        });

        // Only validTo is supplied; validFrom must come from the row.
        await expect(updatePromotion(ctx, 'p-1', { validTo: d('2026-08-01') })).rejects.toThrow(
            /must not precede/i,
        );
        expect(mockPromotion.update).not.toHaveBeenCalled();
    });

    it('404s on a missing promotion, with the CODE not the prose', async () => {
        // Pinned to `code`, not to the English sentence. This asserted
        // `/not found/i` and went red when #2725 gave the throw a code — the
        // message became "No promotion exists under that id." and the test
        // read like a regression while the behaviour had improved.
        //
        // The code is the contract; the message is displayed copy a client
        // translates from `errors.PROMOTION_NOT_FOUND` in both locales. A test
        // pinned to server prose breaks on every copy edit and passes on a
        // wrong code, which is the wrong way round.
        mockPromotion.findUnique.mockResolvedValue(null);
        await expect(updatePromotion(ctx, 'nope', { title: 'X' })).rejects.toMatchObject({
            code: 'PROMOTION_NOT_FOUND',
        });
    });
});

describe('setPromotionPublished', () => {
    it('stamps publishedAt when publishing', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            publishedAt: null,
            company: { name: 'Syngenta' },
        });

        await setPromotionPublished(ctx, 'p-1', true);
        expect(mockPromotion.update.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date);
    });

    it('preserves the original publish time on re-publish', async () => {
        const first = d('2026-07-01');
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            publishedAt: first,
            company: { name: 'Syngenta' },
        });

        await setPromotionPublished(ctx, 'p-1', true);
        expect(mockPromotion.update.mock.calls[0][0].data.publishedAt).toBe(first);
    });

    it('clears publishedAt when unpublishing, without touching the window', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            publishedAt: d('2026-07-01'),
            company: { name: 'Syngenta' },
        });

        await setPromotionPublished(ctx, 'p-1', false);
        const { data } = mockPromotion.update.mock.calls[0][0];
        expect(data.publishedAt).toBeNull();
        expect(data).not.toHaveProperty('validFrom');
    });

    it('audits publication as a status change, not a field diff', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            publishedAt: null,
            company: { name: 'Syngenta' },
        });

        await setPromotionPublished(ctx, 'p-1', true);
        const payload = mockLogEvent.mock.calls[0][2];
        expect(payload.detailsJson.category).toBe('status_change');
        // `toStatus`, not `operation` (#2109). This case asserted
        // `operation: 'published'`, which is the field `entity_lifecycle`
        // declares — so the payload named its destination with the other
        // category's vocabulary, and `StatusChangeSchema.strict()` rejected
        // it. The name of this test was already the argument for the change:
        // a publication IS a status change, so it says where it moved TO.
        expect(payload.detailsJson.toStatus).toBe('PUBLISHED');
        expect(payload.detailsJson.operation).toBeUndefined();
    });

    it('says UNPUBLISHED on the way back', async () => {
        // The other direction, which nothing covered — and the one where a
        // field-diff payload would have been most tempting.
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            publishedAt: new Date('2026-10-01T00:00:00Z'),
            company: { name: 'Syngenta' },
        });

        await setPromotionPublished(ctx, 'p-1', false);
        const payload = mockLogEvent.mock.calls[0][2];
        expect(payload.detailsJson.category).toBe('status_change');
        expect(payload.detailsJson.toStatus).toBe('UNPUBLISHED');
    });
});

describe('deletePromotion', () => {
    it('refuses to delete a promotion that captured enquiries', async () => {
        // PromotionLead cascades on delete — dropping this row would destroy
        // the advertiser's deliverable.
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            company: { name: 'Syngenta' },
            _count: { leads: 3 },
        });

        await expect(deletePromotion(ctx, 'p-1')).rejects.toThrow(/Unpublish it instead/i);
        expect(mockPromotion.delete).not.toHaveBeenCalled();
    });

    it('deletes a promotion with no enquiries', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1',
            title: 'T',
            company: { name: 'Syngenta' },
            _count: { leads: 0 },
        });

        await deletePromotion(ctx, 'p-1');
        expect(mockPromotion.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
    });
});

describe('the review-time ПРЗ classification (#2664)', () => {
    // `Promotion.pppRegistrationNo` has existed since #2673 with a docblock
    // saying it is "Set by the owner at REVIEW time" — and until this change
    // nothing could set it: absent from `promotion-admin.schemas.ts` and from
    // the console form, so every promotion written through the console had it
    // NULL, reachable only by direct database access.
    //
    // That matters because the predicate #2664 proposes — withhold ПРЗ
    // promotions until the Reg. (EC) 1107/2009 Art 66 wording is configured —
    // reads this column, and `NULL` is indistinguishable from "nobody could
    // record it". A fertiliser and a pesticide looked identical.

    it('stores a typed registration number, sanitised', async () => {
        await createPromotion(ctx, {
            companyId: 'c-1',
            title: 'Offer',
            category: 'products',
            pppRegistrationNo: '  01234-ПРЗ  ',
        });
        expect(mockPromotion.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ pppRegistrationNo: '01234-ПРЗ' }),
            }),
        );
    });

    it("stores '' as NULL, because '' == null is FALSE", async () => {
        // THE LOAD-BEARING ONE. The predicate tests `pppRegistrationNo == null`.
        // An empty string is not null, so it would be read as "this IS a plant
        // protection product" and withhold a fertiliser — while the console
        // shows an empty box either way, so nobody could see why. Two spellings
        // of one fact, which is the collapse #2697 was.
        await createPromotion(ctx, {
            companyId: 'c-1',
            title: 'Offer',
            category: 'fertilizer',
            pppRegistrationNo: '',
        });
        const { data } = mockPromotion.create.mock.calls[0][0];
        expect(data.pppRegistrationNo).toBeNull();
    });

    it('stores whitespace-only as NULL — sanitise BEFORE testing emptiness', async () => {
        // `sanitizePlainText` trims (#1825), so three spaces are truthy as
        // given and empty once cleaned. Testing the raw value first — the
        // obvious `v ? sanitize(v) : null` — stores '' and reintroduces the
        // case above.
        await createPromotion(ctx, {
            companyId: 'c-1',
            title: 'Offer',
            category: 'fertilizer',
            pppRegistrationNo: '   ',
        });
        const { data } = mockPromotion.create.mock.calls[0][0];
        expect(data.pppRegistrationNo).toBeNull();
    });

    it('is NULL when the reviewer says nothing', async () => {
        await createPromotion(ctx, { companyId: 'c-1', title: 'Offer', category: 'seeds' });
        const { data } = mockPromotion.create.mock.calls[0][0];
        expect(data.pppRegistrationNo).toBeNull();
    });

    it('an explicit null on edit RECLASSIFIES — this was a ПРЗ, it is not now', async () => {
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1', publishedAt: null, validFrom: null, validTo: null,
        });
        await updatePromotion(ctx, 'p-1', { pppRegistrationNo: null });
        const { data } = mockPromotion.update.mock.calls[0][0];
        expect(data).toHaveProperty('pppRegistrationNo', null);
    });

    it('an omitted field leaves the stored classification ALONE', async () => {
        // The distinction every other field here relies on: `undefined` means
        // "not part of this edit". Writing null on omission would silently
        // declassify a ПРЗ whenever somebody fixed a typo in the title.
        mockPromotion.findUnique.mockResolvedValue({
            id: 'p-1', publishedAt: null, validFrom: null, validTo: null,
        });
        await updatePromotion(ctx, 'p-1', { title: 'Corrected title' });
        const { data } = mockPromotion.update.mock.calls[0][0];
        expect(data).not.toHaveProperty('pppRegistrationNo');
    });
});

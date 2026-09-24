/**
 * The operator's copy of an insurance enquiry.
 *
 * Three properties, and each exists because the obvious implementation gets
 * it wrong in a way nothing would report:
 *
 *  • **`audience: 'platform'`.** The tenant is the SUBJECT of this mail, not
 *    its reader. Enqueued as a tenant notification it would be governed by
 *    `TenantNotificationSettings.enabled`, so a farm could silence the
 *    operator's copy of their own enquiry — silently.
 *
 *  • **A missing address costs nobody their lead.** The row is committed
 *    before any mail is attempted, and the farmer's confirmation is separate.
 *    Configuration that is absent must not turn a successful request into a
 *    failure.
 *
 *  • **A mail failure is swallowed.** Same reason, one step further: the lead
 *    cannot be un-asked, so throwing here would show an error for something
 *    that already succeeded.
 */
const enqueueEmail = jest.fn(async () => ({ id: 'n1', dedupeKey: 'k' }));
jest.mock('../../../src/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => enqueueEmail(...(a as [])),
}));

const mockDb = {
    insuranceLead: { create: jest.fn(), findMany: jest.fn() },
    tenant: { findUnique: jest.fn() },
    parcel: { findFirst: jest.fn() },
    notification: { create: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));
jest.mock('../../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(), assertCanWrite: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (v: string) => v }));

const envMock: { INSURANCE_LEAD_NOTIFY_EMAIL?: string } = {};
jest.mock('@/env', () => ({ env: envMock }));

import { createInsuranceLead } from '@/app-layer/usecases/insurance';
import { makeRequestContext } from '../../helpers/make-context';

const CTX = makeRequestContext('EDITOR', { tenantId: 't1', userId: 'u1' });
const INPUT = { parcelId: 'p1', locationId: 'l1', message: 'Интересува ме оферта', risk: null };

beforeEach(() => {
    jest.clearAllMocks();
    envMock.INSURANCE_LEAD_NOTIFY_EMAIL = 'ops@example.test';
    mockDb.insuranceLead.create.mockResolvedValue({ id: CREATED_LEAD_ID });
    mockDb.tenant.findUnique.mockResolvedValue({ name: 'Агрент', slug: 'agrent' });
    mockDb.parcel.findFirst.mockResolvedValue({
        name: '15655-19', cropType: 'wheat', areaHa: 12.4, location: { name: 'Северен блок' },
    });
});

/** The id the create returns — what the operator mail must be deduped on. */
const CREATED_LEAD_ID = 'lead-1';

describe('the operator copy', () => {
    it('is enqueued with the PLATFORM audience', async () => {
        await createInsuranceLead(CTX, INPUT);
        const [, input] = enqueueEmail.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        // The property that stops a tenant silencing it.
        expect(input.audience).toBe('platform');
        expect(input.type).toBe('INSURANCE_LEAD');
        expect(input.toEmail).toBe('ops@example.test');
    });

    it('states the locale explicitly rather than defaulting', async () => {
        // The recipient is an address from configuration — there is no user
        // row and therefore no uiLanguage. The convention is that such a
        // producer writes the locale so the choice shows in the diff.
        await createInsuranceLead(CTX, INPUT);
        const [, input] = enqueueEmail.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(input.locale).toBe('bg');
    });

    it('carries the parcel facts the operator needs to act', async () => {
        await createInsuranceLead(CTX, INPUT);
        const [, input] = enqueueEmail.mock.calls[0] as unknown as [unknown, { payload: Record<string, unknown> }];
        expect(input.payload).toMatchObject({
            tenantName: 'Агрент',
            parcelName: '15655-19',
            locationName: 'Северен блок',
            cropType: 'wheat',
            areaHa: 12.4,
            message: 'Интересува ме оферта',
        });
    });
});

describe('the mail is deduped on the LEAD, not the parcel', () => {
    it('passes the created lead id as the dedupe entity', async () => {
        // `buildDedupeKey` composes `tenant:type:email:entityId:DAY`, and
        // `enqueueEmail` SILENTLY skips a duplicate key. Keying on the parcel
        // meant a second ask for the same parcel on the same day wrote an
        // InsuranceLead row and sent NO mail.
        //
        // That was harmless while the unique on (parcelId, inquirerTenantId)
        // made a second ask impossible. The moment repeat asks were allowed —
        // so a farmer could correct their land size — it became the defect
        // that eats precisely the message the operator needs: the corrected
        // figure, sent the same afternoon as the first.
        await createInsuranceLead(CTX, INPUT);
        const [, input] = enqueueEmail.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
        expect(input.entityId).toBe(CREATED_LEAD_ID);
        // The parcel id is what it must NOT be — asserted by name, because
        // "some string" would pass either way.
        expect(input.entityId).not.toBe(INPUT.parcelId);
    });
});

describe('what must NOT cost the farmer their lead', () => {
    it('records the lead when no operator address is configured', async () => {
        envMock.INSURANCE_LEAD_NOTIFY_EMAIL = undefined;
        await expect(createInsuranceLead(CTX, INPUT)).resolves.toBeDefined();
        expect(mockDb.insuranceLead.create).toHaveBeenCalled();
        expect(enqueueEmail).not.toHaveBeenCalled();
    });

    it('records the lead when the mail enqueue throws', async () => {
        // The row is already committed and cannot be un-asked. Throwing here
        // would report a failure for something that succeeded.
        enqueueEmail.mockRejectedValueOnce(new Error('smtp down') as never);
        await expect(createInsuranceLead(CTX, INPUT)).resolves.toBeDefined();
        expect(mockDb.insuranceLead.create).toHaveBeenCalled();
    });

    it('records the lead when the parcel lookup finds nothing', async () => {
        // A deleted parcel mid-request must not break the write that already
        // happened; the mail falls back to the id.
        mockDb.parcel.findFirst.mockResolvedValue(null);
        await expect(createInsuranceLead(CTX, INPUT)).resolves.toBeDefined();
        const [, input] = enqueueEmail.mock.calls[0] as unknown as [unknown, { payload: Record<string, unknown> }];
        expect(input.payload.parcelName).toBe('p1');
    });
});

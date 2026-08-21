/**
 * `listInquiredParcelIds` — the read half of `InsuranceLead` that never
 * existed.
 *
 * Issue #664. Before this, the ONLY queries against `InsuranceLead` anywhere
 * in `src/app-layer` were the retention job's cross-tenant sweep. There was no
 * tenant-facing reader at all, which is why the Risk page fell back to
 * component-local `useState` and forgot on navigation.
 *
 * The two properties worth pinning are both about what the query must NOT do:
 * it must scope to the calling tenant, and it must return ids rather than rows.
 */

const findMany = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (
        _ctx: unknown,
        fn: (db: unknown) => unknown,
    ) => fn({ insuranceLead: { findMany } }),
}));

const assertCanRead = jest.fn();
jest.mock('@/app-layer/policies/common', () => ({
    ...jest.requireActual('@/app-layer/policies/common'),
    assertCanRead: (...a: unknown[]) => assertCanRead(...a),
    assertCanWrite: jest.fn(),
}));

import { listInquiredParcelIds } from '@/app-layer/usecases/insurance';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { tenantId: 't-acme' });

beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
    assertCanRead.mockReset();
});

describe('listInquiredParcelIds', () => {
    it('returns just the ids', async () => {
        findMany.mockResolvedValue([{ parcelId: 'p-1' }, { parcelId: 'p-2' }]);
        await expect(listInquiredParcelIds(ctx)).resolves.toEqual(['p-1', 'p-2']);
    });

    it('scopes to the CALLING tenant', async () => {
        // `InsuranceLead` is not tenant-scoped — `inquirerTenantId` is a plain
        // FK, like PromotionLead — so RLS does not do this for us. The filter
        // IS the isolation.
        await listInquiredParcelIds(ctx);
        expect(findMany.mock.calls[0][0].where).toMatchObject({
            inquirerTenantId: 't-acme',
        });
    });

    it('selects ONLY parcelId — never the farmer-written message', async () => {
        // The caller asks "whether", not "what". `message` is free text a
        // farmer wrote about their own operation; shipping it to render a
        // disabled button would hand out more than the question asked for.
        await listInquiredParcelIds(ctx);
        expect(findMany.mock.calls[0][0].select).toEqual({ parcelId: true });
    });

    it('is bounded', async () => {
        // An unbounded repository findMany trips the query-shape guardrail,
        // and a tenant with thousands of open requests is not worth paging
        // for here — the UI only asks about parcels on screen.
        expect(findMany.mock.calls.length).toBe(0);
        await listInquiredParcelIds(ctx);
        expect(findMany.mock.calls[0][0].take).toBeGreaterThan(0);
    });

    it('narrows to the given parcels when asked', async () => {
        await listInquiredParcelIds(ctx, { parcelIds: ['p-1', 'p-9'] });
        expect(findMany.mock.calls[0][0].where).toMatchObject({
            parcelId: { in: ['p-1', 'p-9'] },
        });
    });

    it('does NOT emit an empty `in` filter for an empty list', async () => {
        // `{ in: [] }` matches nothing, so a caller passing an empty array
        // would silently get "you have inquired about nothing" rather than
        // the unfiltered answer. Same trap as the multi-select facet in
        // grain/contracts.
        await listInquiredParcelIds(ctx, { parcelIds: [] });
        expect(findMany.mock.calls[0][0].where.parcelId).toBeUndefined();
    });

    it('checks read permission before querying', async () => {
        await listInquiredParcelIds(ctx);
        expect(assertCanRead).toHaveBeenCalledWith(ctx);
    });
});

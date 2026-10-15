/**
 * Somebody can publish a farm (P6.1, #1810).
 *
 * The companion to the projection writer's integration suite, and not
 * redundant with it. That suite proves `projectFarmBrand` behaves against a
 * real database; it would have been just as green while nothing could call it
 * — which is the finding #1793 recorded, where a complete, tested, audited
 * usecase had zero callers and its own refusal codes sat undocumented because
 * there was no operation to attach them to.
 *
 * So this drives the real route handler.
 *
 * ## The mistake it is built around
 *
 * `published` is a boolean, and `setFarmBrandPublication(ctx, body.published)`
 * compiles just as well as `(ctx, true)` or `(ctx, !body.published)`. All
 * three type-check, and two of them publish a farm that asked to be withdrawn
 * — which is the direction that is hard to take back. So the cases below
 * assert the value that ARRIVED, in both directions, rather than that the
 * usecase was called.
 */
// The flag gating this route (#1886) is OFF by default, which is the point of
// it. This suite's subject is that the route REACHES its usecase, so it runs
// with the gate open; the gate itself is asserted in
// `tests/integration/p6-public-surfaces-are-gated.test.ts`.
jest.mock('@/lib/feature-flags', () => ({
    ...jest.requireActual('@/lib/feature-flags'),
    isFeatureEnabled: async () => true,
    assertFeatureEnabled: async () => undefined,
}));

import { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';

let currentCtx: RequestContext = makeRequestContext('ADMIN', { userId: 'u-owner' });
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: async () => currentCtx,
}));

const setFarmBrandPublication = jest.fn();
// Only the one symbol the route imports, so the real usecase's dependency
// graph is never loaded.
jest.mock('@/app-layer/usecases/public-farm-profile', () => ({
    setFarmBrandPublication: (...args: unknown[]) => setFarmBrandPublication(...args),
}));

// REQUIRED, not imported, so it loads after the mocks are registered.
const route = require('../../src/app/api/t/[tenantSlug]/farm-brand/publication/route');

const URL_ = 'http://x/api/t/acme/farm-brand/publication';

function put(body: unknown): NextRequest {
    return new NextRequest(URL_, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const params = () => ({ params: Promise.resolve({ tenantSlug: 'acme' }) });

beforeEach(() => {
    setFarmBrandPublication.mockReset();
    setFarmBrandPublication.mockResolvedValue({
        handle: 'farm-pobeda',
        withdrawn: false,
        removedHandle: null,
    });
    currentCtx = makeRequestContext('ADMIN', { userId: 'u-owner' });
});

describe('PUT /farm-brand/publication', () => {
    it('reaches the usecase at all', async () => {
        const res = await route.PUT(put({ published: true }), params());

        expect(res.status).toBe(200);
        expect(setFarmBrandPublication).toHaveBeenCalledTimes(1);
    });

    it('forwards published: true', async () => {
        await route.PUT(put({ published: true }), params());
        expect(setFarmBrandPublication.mock.calls[0][1]).toBe(true);
    });

    it('forwards published: FALSE — not inverted, not hardcoded', async () => {
        // The case that catches `(ctx, true)` and `(ctx, !body.published)`,
        // both of which compile. Without it, a route that always published
        // would pass every other assertion here.
        await route.PUT(put({ published: false }), params());
        expect(setFarmBrandPublication.mock.calls[0][1]).toBe(false);
    });

    it('passes the tenant context, so the usecase can apply its own gates', async () => {
        await route.PUT(put({ published: true }), params());
        expect(setFarmBrandPublication.mock.calls[0][0]).toBe(currentCtx);
    });

    it('answers with the projection result, including a rename’s removed handle', async () => {
        setFarmBrandPublication.mockResolvedValue({
            handle: 'farm-new',
            withdrawn: false,
            removedHandle: 'farm-old',
        });

        const res = await route.PUT(put({ published: true }), params());

        // `removedHandle` is the field a client needs to know a printed QR has
        // stopped working, so it must survive the envelope.
        expect(await res.json()).toEqual({
            handle: 'farm-new',
            withdrawn: false,
            removedHandle: 'farm-old',
        });
    });

    describe('the body is validated BEFORE the usecase runs', () => {
        it('refuses an ABSENT published, rather than defaulting it', async () => {
            // The one that matters. A schema default would let a client that
            // forgot the field publish a farm by accident.
            const res = await route.PUT(put({}), params());

            expect(res.status).toBe(400);
            expect(setFarmBrandPublication).not.toHaveBeenCalled();
        });

        it('refuses a non-boolean', async () => {
            const res = await route.PUT(put({ published: 'yes' }), params());

            expect(res.status).toBe(400);
            expect(setFarmBrandPublication).not.toHaveBeenCalled();
        });
    });
});

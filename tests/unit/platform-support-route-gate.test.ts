/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirroring
 * runtime contracts (NextRequest, route handler args); the file-level disable
 * is this codebase's standard pattern for these surfaces. */

/**
 * The platform-support gate must stop a REQUEST — not merely throw when called.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * `assertPlatformSupport` itself is well tested — `platform-support-gate.test.ts`
 * imports the real function and drives it to 100% coverage. What was untested is
 * every place it is USED. Ten route lines are the only thing standing between one
 * farm's admin and the global catalogues that render in EVERY tenant's feed, and
 * commenting out both calls in `admin/promotions/route.ts` left 2173/2173 tests
 * green. No test imported any of these route modules.
 *
 * That is the severed seam in its purest form: the mechanism has a thorough
 * direct-import suite, the enforcement points have nothing. A gate function
 * nobody calls is exactly as protective as no gate at all, and the existing
 * suite cannot tell the two apart.
 *
 * The near-miss worth naming: `tests/unit/market/manual-prices.test.ts:31`
 * does `jest.mock('@/lib/auth/platform-support')` with a `jest.fn()`. It asserts
 * the USECASE calls the gate, which is real coverage of that one call site — but
 * it never executes the gate, so it cannot tell you the gate works, and it says
 * nothing about the ten ROUTE sites.
 *
 * So this file mocks the ctx source and the downstream effects, keeps
 * `assertPlatformSupport`, `requirePermission` and `withApiErrorHandling` REAL,
 * and asserts the thing that actually protects a tenant: **a non-platform
 * tenant's admin is refused, and never reaches the catalogue.**
 *
 * Note the status is 404, not 403 — deliberately. From another tenant's
 * perspective this console does not exist, and a 403 would confirm that a
 * global-catalogue surface is there to be found (see platform-support.ts:71-75).
 */
export {};

const mockEnv: Record<string, unknown> = {};
jest.mock('@/env', () => ({
    get env() {
        // Overlay ONLY the platform slug. A bare literal would strip every
        // other key, and this file pulls in far more of the import graph than
        // the function-level suite does — the route modules reach prisma,
        // storage and observability, all of which read env at module load.
        return { ...jest.requireActual('@/env').env, ...mockEnv };
    },
}));

const getTenantCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    ...jest.requireActual('@/app-layer/context'),
    getTenantCtx: (...a: any[]) => getTenantCtx(...a),
}));

// Downstream effects. Each is the FIRST thing the handler does after the gate,
// so "was this called?" is a direct read on whether the gate let the request
// through. These are the assertions that fail if a call site is deleted.
const promotionAdmin = {
    listAllPromotions: jest.fn().mockResolvedValue([]),
    createPromotion: jest.fn().mockResolvedValue({ id: 'promo_1' }),
    updatePromotion: jest.fn().mockResolvedValue({ id: 'promo_1' }),
    setPromotionPublished: jest.fn().mockResolvedValue({ id: 'promo_1' }),
    deletePromotion: jest.fn().mockResolvedValue(undefined),
    listCompanies: jest.fn().mockResolvedValue([]),
};
jest.mock('@/app-layer/usecases/promotion-admin', () => promotionAdmin);

const companyUsecase = { updateCompany: jest.fn().mockResolvedValue({ id: 'co_1' }) };
jest.mock('@/app-layer/usecases/company', () => companyUsecase);

const marketManual = { upsertManualPriceSeries: jest.fn().mockResolvedValue({ count: 0 }) };
jest.mock('@/app-layer/usecases/market-manual-prices', () => marketManual);

const promotionImage = {
    uploadPromotionImage: jest.fn().mockResolvedValue({ url: '/x.webp' }),
    removePromotionImage: jest.fn().mockResolvedValue(undefined),
    PROMOTION_IMAGE_MAX_BYTES: 5 * 1024 * 1024,
};
jest.mock('@/lib/promotions/promotion-image', () => promotionImage);

import { NextRequest } from 'next/server';
import { makeRequestContext } from '../helpers/make-context';

import * as promotionsRoute from '@/app/api/t/[tenantSlug]/admin/promotions/route';
import * as promotionByIdRoute from '@/app/api/t/[tenantSlug]/admin/promotions/[id]/route';
import * as promotionImageRoute from '@/app/api/t/[tenantSlug]/admin/promotions/[id]/image/route';
import * as companiesRoute from '@/app/api/t/[tenantSlug]/admin/companies/route';
import * as companyByIdRoute from '@/app/api/t/[tenantSlug]/admin/companies/[id]/route';
import * as marketPricesRoute from '@/app/api/t/[tenantSlug]/admin/market-prices/route';

const PLATFORM_SLUG = 'agrent-platform';
/** A farm. Holds `admin.manage` in its OWN tenant — that is the whole point. */
const FARM_SLUG = 'acme-corp';

type Case = {
    name: string;
    handler: (req: any, args: any) => Promise<Response>;
    method: string;
    path: string;
    params: Record<string, string>;
    body?: unknown;
    /** The effect that must NOT happen when the gate refuses. */
    effect: jest.Mock;
};

const CASES: Case[] = [
    {
        name: 'promotions GET',
        handler: promotionsRoute.GET as any,
        method: 'GET',
        path: '/admin/promotions',
        params: {},
        effect: promotionAdmin.listAllPromotions,
    },
    {
        name: 'promotions POST',
        handler: promotionsRoute.POST as any,
        method: 'POST',
        path: '/admin/promotions',
        params: {},
        body: {},
        effect: promotionAdmin.createPromotion,
    },
    {
        name: 'promotions/[id] PATCH',
        handler: promotionByIdRoute.PATCH as any,
        method: 'PATCH',
        path: '/admin/promotions/promo_1',
        params: { id: 'promo_1' },
        body: {},
        effect: promotionAdmin.updatePromotion,
    },
    {
        name: 'promotions/[id] PUT',
        handler: promotionByIdRoute.PUT as any,
        method: 'PUT',
        path: '/admin/promotions/promo_1',
        params: { id: 'promo_1' },
        body: {},
        effect: promotionAdmin.setPromotionPublished,
    },
    {
        name: 'promotions/[id] DELETE',
        handler: promotionByIdRoute.DELETE as any,
        method: 'DELETE',
        path: '/admin/promotions/promo_1',
        params: { id: 'promo_1' },
        effect: promotionAdmin.deletePromotion,
    },
    {
        name: 'promotions/[id]/image POST',
        handler: promotionImageRoute.POST as any,
        method: 'POST',
        path: '/admin/promotions/promo_1/image',
        params: { id: 'promo_1' },
        effect: promotionImage.uploadPromotionImage,
    },
    {
        name: 'promotions/[id]/image DELETE',
        handler: promotionImageRoute.DELETE as any,
        method: 'DELETE',
        path: '/admin/promotions/promo_1/image',
        params: { id: 'promo_1' },
        effect: promotionImage.removePromotionImage,
    },
    {
        name: 'companies GET',
        handler: companiesRoute.GET as any,
        method: 'GET',
        path: '/admin/companies',
        params: {},
        effect: promotionAdmin.listCompanies,
    },
    {
        name: 'companies/[id] PATCH',
        handler: companyByIdRoute.PATCH as any,
        method: 'PATCH',
        path: '/admin/companies/co_1',
        params: { id: 'co_1' },
        body: {},
        effect: companyUsecase.updateCompany,
    },
    {
        name: 'market-prices POST',
        handler: marketPricesRoute.POST as any,
        method: 'POST',
        path: '/admin/market-prices',
        params: {},
        body: {},
        effect: marketManual.upsertManualPriceSeries,
    },
];

function callRoute(c: Case, tenantSlug: string) {
    const url = `http://localhost:3000/api/t/${tenantSlug}${c.path}`;
    const init: RequestInit = { method: c.method };
    if (c.body !== undefined) {
        init.body = JSON.stringify(c.body);
        init.headers = { 'content-type': 'application/json' };
    }
    // NextRequest, not Request: `withApiErrorHandling` reads `req.nextUrl`
    // (api.ts:128) for its route label, and a plain Request has no such
    // property — the handler would blow up before reaching the gate.
    const req = new NextRequest(url, init as any);
    return c.handler(req, { params: Promise.resolve({ tenantSlug, ...c.params }) });
}

beforeEach(() => {
    // clearAllMocks wipes CALLS but NOT implementations, so the
    // `mockResolvedValue`s declared at module scope survive — which is what
    // we want; only the call records need to be per-test.
    jest.clearAllMocks();
    mockEnv.PLATFORM_TENANT_SLUG = PLATFORM_SLUG;
    getTenantCtx.mockReset();
});

describe('every gated route refuses a tenant that is not the platform tenant', () => {
    it.each(CASES.map((c) => [c.name, c] as const))(
        '%s => 404, and the catalogue is never touched',
        async (_name, c) => {
            getTenantCtx.mockResolvedValue(
                makeRequestContext('OWNER', {
                    userId: 'u_farm',
                    tenantId: 'tnt_farm',
                    tenantSlug: FARM_SLUG,
                }),
            );

            const res = await callRoute(c, FARM_SLUG);

            // 404, not 403 — the console must not be discoverable.
            expect(res.status).toBe(404);
            // The load-bearing half: refusing with a status while still
            // running the handler would be no protection at all.
            expect(c.effect).not.toHaveBeenCalled();
        },
    );

    it('an OWNER is refused just as an EDITOR is — role is not the axis', async () => {
        // `admin.manage` resolves from Role, so EVERY tenant's OWNER holds it.
        // If the gate were mistaken for a permission check, this would pass.
        for (const role of ['OWNER', 'ADMIN'] as const) {
            getTenantCtx.mockResolvedValue(
                makeRequestContext(role, { tenantSlug: FARM_SLUG }),
            );
            const res = await callRoute(CASES[0], FARM_SLUG);
            expect(res.status).toBe(404);
        }
    });
});

describe('the gate is not simply always-closed', () => {
    it.each(CASES.map((c) => [c.name, c] as const))(
        '%s lets the platform tenant through',
        async (_name, c) => {
            getTenantCtx.mockResolvedValue(
                makeRequestContext('OWNER', {
                    userId: 'u_support',
                    tenantId: 'tnt_platform',
                    tenantSlug: PLATFORM_SLUG,
                }),
            );

            const res = await callRoute(c, PLATFORM_SLUG);

            // Past the gate. A handler may still fail downstream on a body
            // this test does not bother to make valid — what must not happen
            // is the gate's own 404.
            expect(res.status).not.toBe(404);
        },
    );
});

describe('fail closed — unconfigured means unreachable, not universal', () => {
    it.each(CASES.map((c) => [c.name, c] as const))(
        '%s refuses even the platform tenant when PLATFORM_TENANT_SLUG is unset',
        async (_name, c) => {
            // The misconfiguration path. An env var that silently grants
            // global write access when blank is the failure this guards.
            delete mockEnv.PLATFORM_TENANT_SLUG;
            getTenantCtx.mockResolvedValue(
                makeRequestContext('OWNER', { tenantSlug: PLATFORM_SLUG }),
            );

            const res = await callRoute(c, PLATFORM_SLUG);

            expect(res.status).toBe(404);
            expect(c.effect).not.toHaveBeenCalled();
        },
    );
});

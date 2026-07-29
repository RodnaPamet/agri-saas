import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import {
    createInquiry,
    listInquiriesByInquirer,
} from '@/app-layer/usecases/exchange';
import { CreateInquirySchema } from '@/app-layer/schemas/exchange.schemas';
import { toPublicInquiry } from '@/lib/exchange/public-listing';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { EXCHANGE_INQUIRY_LIMIT } from '@/lib/security/rate-limit-middleware';
import type { NextRequest } from 'next/server';

/**
 * Exchange inquiries (EXCHANGE module).
 *
 *   GET  → the caller-tenant's OUTBOX — inquiries it has sent, each with the
 *          listing's public projection + status ("My interests").
 *   POST → express interest in another tenant's ACTIVE listing. The usecase
 *          persists the inquiry then notifies + emails the seller's admins
 *          (fail-open, cross-tenant email is the one mediated channel).
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'EXCHANGE');
        const rows = await listInquiriesByInquirer(ctx);
        return jsonResponse(rows.map((r) => toPublicInquiry(r, ctx.tenantId)));
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        CreateInquirySchema,
        async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            await assertModuleEnabled(ctx, 'EXCHANGE');
            const inquiry = await createInquiry(ctx, {
                listingId: body.listingId,
                message: body.message,
                // PRIVATE — stored with the inquiry, shown to the seller only
                // once they ACCEPT (the `toPublicInquiry` reveal gate). It is
                // deliberately NOT in the seller's inquiry email: that email
                // goes to every seller admin before anyone has consented.
                inquirerContact: body.inquirerContact ?? null,
                quantityTonnes: body.quantityTonnes ?? null,
            });
            return jsonResponse({ id: inquiry.id, status: inquiry.status }, { status: 201 });
        },
    ),
    // Tighter than listing-create: each inquiry triggers a cross-tenant EMAIL
    // fanout to the seller's admins, so cap the outbound-email blast.
    { rateLimit: { config: EXCHANGE_INQUIRY_LIMIT, scope: 'exchange-inquiry' } },
);

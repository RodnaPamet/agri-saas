import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { findOrCreateCustomer, createPortalSession } from '@/lib/stripe';
import { env } from '@/env';
import { jsonResponse } from '@/lib/api-response';
import { codedForbidden, forbidden } from '@/lib/errors/types';
import { getBillingMode } from '@/lib/billing/entitlements';

/**
 * POST /api/t/[tenantSlug]/billing/portal
 * Creates a Stripe Customer Portal session.
 * Gated by `admin.manage` (Epic D.3).
 *
 * Self-hosted mode (no STRIPE_SECRET_KEY) returns a structured 403
 * "billing_unavailable" — same shape as the checkout route — so the
 * client-side error UI renders a deterministic message instead of
 * an opaque 500 from `getStripe()`.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        if (getBillingMode() === 'SELFHOSTED') {
            throw codedForbidden(
    'BILLING_UNAVAILABLE',
    'This deployment runs in self-hosted mode; ' +
                    'subscription management is not exposed via the in-app portal.',
    { mode: 'SELFHOSTED' },
);
        }
        const appUrl = env.APP_URL || `https://${req.headers.get('host') || 'localhost:3000'}`;

        const { stripeCustomerId } = await findOrCreateCustomer(
            ctx.tenantId,
            ctx.tenantSlug!,
            '',
        );

        const url = await createPortalSession(
            stripeCustomerId,
            `${appUrl}/t/${ctx.tenantSlug}/admin`,
        );

        return jsonResponse({ url });
    }),
);

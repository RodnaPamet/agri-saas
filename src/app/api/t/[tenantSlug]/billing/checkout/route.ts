import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { findOrCreateCustomer, createCheckoutSession } from '@/lib/stripe';
import { env } from '@/env';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';
import { codedForbidden, forbidden } from '@/lib/errors/types';
import { getBillingMode } from '@/lib/billing/entitlements';

const CheckoutBody = z.object({
    plan: z.enum(['PRO', 'ENTERPRISE']),
});

/**
 * POST /api/t/[tenantSlug]/billing/checkout
 * Creates a Stripe Checkout Session for the given plan.
 * Gated by `admin.manage` (Epic D.3).
 *
 * Self-hosted mode (no STRIPE_SECRET_KEY) returns a structured 403
 * "billing_unavailable" instead of the bare 500 the underlying
 * `getStripe()` would have thrown — keeps the client error path
 * deterministic and the UI banner informative.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        if (getBillingMode() === 'SELFHOSTED') {
            throw codedForbidden(
                'BILLING_UNAVAILABLE',
                'billing_unavailable: this deployment runs in self-hosted mode; ' +
                    'plan changes are not exposed via the in-app checkout.',
                { mode: 'SELFHOSTED' },
            );
        }
        const body = CheckoutBody.parse(await req.json());
        const appUrl = env.APP_URL || `https://${req.headers.get('host') || 'localhost:3000'}`;

        // Find or create Stripe customer + BillingAccount
        const { stripeCustomerId } = await findOrCreateCustomer(
            ctx.tenantId,
            ctx.tenantSlug!, // always set in tenant-scoped routes
            '', // email resolved from session if needed
        );

        const url = await createCheckoutSession(
            stripeCustomerId,
            body.plan,
            `${appUrl}/t/${ctx.tenantSlug}/admin?billing=success`,
            `${appUrl}/t/${ctx.tenantSlug}/admin?billing=canceled`,
        );

        return jsonResponse({ url });
    }),
);

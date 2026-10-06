import Stripe from 'stripe';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';

// ─── Types (matching Prisma enums, duplicated so we don't depend on generated client at import time) ───

type BillingPlan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';
type BillingStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'INCOMPLETE' | 'TRIALING';

// ─── Lazy Stripe client ───

let _stripe: Stripe | null = null;

/**
 * The Stripe API version this code was written and tested against.
 *
 * Pinned DELIBERATELY, and hard-coded rather than taken from the SDK's own
 * `ApiVersion` export. `new Stripe(key)` with no `apiVersion` adopts whatever
 * the installed SDK defaults to, so an SDK major silently changes which API
 * production talks to — a behavioural change to payments that appears in a
 * diff as a version number and that no typecheck or test can see. stripe@23
 * moved this pin from the v22 default; the bump landed in #1309 while billing
 * was dormant, which is the only reason it cost nothing.
 *
 * The SDK types `apiVersion` as `typeof ApiVersion` — a single literal — so
 * this constant stops compiling the moment a future SDK ships a different
 * version. That is the point: the upgrade becomes a compile error and a
 * deliberate decision, instead of a silent one.
 */
const STRIPE_API_VERSION = '2026-09-30.endive';

export function getStripe(): Stripe {
    if (_stripe) return _stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
    return _stripe;
}

// ─── Price mapping ───

const PLAN_PRICE_MAP: Record<string, string | undefined> = {
    PRO: process.env.STRIPE_PRICE_ID_PRO,
    ENTERPRISE: process.env.STRIPE_PRICE_ID_ENTERPRISE,
};

export function getPriceId(plan: 'PRO' | 'ENTERPRISE'): string {
    const priceId = PLAN_PRICE_MAP[plan];
    if (!priceId) throw new Error(`No Stripe price configured for plan: ${plan}`);
    return priceId;
}

// ─── Customer helpers ───

export async function findOrCreateCustomer(
    tenantId: string,
    tenantName: string,
    adminEmail: string,
): Promise<{ billingAccountId: string; stripeCustomerId: string }> {
    const stripe = getStripe();

    // Check for existing billing account
    const existing = await prisma.billingAccount.findUnique({
        where: { tenantId },
    });

    if (existing) {
        return {
            billingAccountId: existing.id,
            stripeCustomerId: existing.stripeCustomerId,
        };
    }

    // Create Stripe customer
    const customer = await stripe.customers.create({
        name: tenantName,
        email: adminEmail,
        metadata: { tenantId },
    });

    // Create billing account
    const billingAccount = await prisma.billingAccount.create({
        data: {
            tenantId,
            stripeCustomerId: customer.id,
            plan: 'FREE',
            status: 'ACTIVE',
        },
    });

    return {
        billingAccountId: billingAccount.id,
        stripeCustomerId: customer.id,
    };
}

// ─── Checkout Session ───

export async function createCheckoutSession(
    stripeCustomerId: string,
    plan: 'PRO' | 'ENTERPRISE',
    successUrl: string,
    cancelUrl: string,
): Promise<string> {
    const stripe = getStripe();
    const priceId = getPriceId(plan);

    const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
            metadata: { plan },
        },
    });

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return session.url;
}

// ─── Customer Portal ───

export async function createPortalSession(
    stripeCustomerId: string,
    returnUrl: string,
): Promise<string> {
    const stripe = getStripe();

    const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });

    return session.url;
}

// ─── Webhook signature verification ───

export function constructWebhookEvent(
    payload: string | Buffer,
    signature: string,
): Stripe.Event {
    const stripe = getStripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    return stripe.webhooks.constructEvent(payload, signature, secret);
}

// ─── Stripe subscription status → BillingStatus mapping ───

function mapStripeStatus(status: string): BillingStatus {
    switch (status) {
        case 'active': return 'ACTIVE';
        case 'past_due': return 'PAST_DUE';
        case 'canceled': return 'CANCELED';
        case 'incomplete': return 'INCOMPLETE';
        case 'trialing': return 'TRIALING';
        case 'incomplete_expired': return 'CANCELED';
        case 'unpaid': return 'PAST_DUE';
        default: return 'ACTIVE';
    }
}

// ─── Stripe subscription → BillingPlan ───

/**
 * Which plan a subscription is for, or `null` when it cannot be determined.
 *
 * This used to `return 'PRO'` for anything it did not recognise, including a
 * subscription with no metadata at all. `getEffectivePlan()` reads this column
 * to decide entitlements, so that default silently granted the PRO plan to any
 * subscription created outside our own checkout — from the Stripe dashboard, a
 * migration, or the API. Guessing in the customer's favour is the expensive
 * direction to guess in.
 *
 * Two sources, in order of trustworthiness:
 *   1. `metadata.plan` — what `createCheckoutSession` stamps on every
 *      subscription it creates, so our own flow always hits this.
 *   2. the subscription's PRICE id — covers a subscription created outside
 *      that flow, as long as it uses a price we configured.
 *
 * `null` means "do not know", and the caller leaves the stored plan alone
 * rather than inventing one.
 */
function resolvePlan(sub: Record<string, unknown>): BillingPlan | null {
    const metadata = sub.metadata as Record<string, string> | null | undefined;
    const declared = metadata?.plan;
    if (declared === 'PRO' || declared === 'ENTERPRISE') return declared;

    const items = sub.items as
        | { data?: Array<{ price?: { id?: string } }> }
        | undefined;
    const priceId = items?.data?.[0]?.price?.id;
    if (!priceId) return null;
    if (priceId === process.env.STRIPE_PRICE_ID_PRO) return 'PRO';
    if (priceId === process.env.STRIPE_PRICE_ID_ENTERPRISE) return 'ENTERPRISE';
    return null;
}

// ─── Subscription period helpers ───
// Stripe v20 moved current_period_end to subscription items.
// We extract it from items or fall back to a safe default.

function getSubscriptionPeriodEnd(sub: Record<string, unknown>): Date | null {
    // Try top-level (older API versions)
    if (typeof sub.current_period_end === 'number') {
        return new Date(sub.current_period_end * 1000);
    }
    // Try items array (Stripe v20+)
    const items = sub.items as { data?: Array<{ current_period_end?: number }> } | undefined;
    if (items?.data?.[0]?.current_period_end) {
        return new Date(items.data[0].current_period_end * 1000);
    }
    return null;
}

function getSubscriptionTrialEnd(sub: Record<string, unknown>): Date | null {
    if (typeof sub.trial_end === 'number') {
        return new Date(sub.trial_end * 1000);
    }
    return null;
}

// ─── Event processor (source of truth for billing state) ───

const db = prisma;

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
    // Idempotency: skip if already processed
    const existingEvent = await db.billingEvent.findUnique({
        where: { stripeEventId: event.id },
    });
    if (existingEvent) {
        logger.debug('Skipping duplicate event', { component: 'billing', eventId: event.id, eventType: event.type });
        return;
    }

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const customerId = session.customer as string;
            const subscriptionId = session.subscription as string;
            if (!customerId || !subscriptionId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // Fetch full subscription for status + metadata
            const stripe = getStripe();
            const subResponse = await stripe.subscriptions.retrieve(subscriptionId);
            const sub = subResponse as unknown as Record<string, unknown>;

            const checkoutPlan = resolvePlan(sub);
            if (!checkoutPlan) {
                logger.warn('Could not determine plan from subscription; leaving the stored plan unchanged', {
                    component: 'billing', subscriptionId, stripeCustomerId: customerId,
                });
            }

            await db.billingAccount.update({
                where: { stripeCustomerId: customerId },
                data: {
                    stripeSubscriptionId: subscriptionId,
                    ...(checkoutPlan ? { plan: checkoutPlan } : {}),
                    status: mapStripeStatus(sub.status as string),
                    currentPeriodEnd: getSubscriptionPeriodEnd(sub),
                    trialEndsAt: getSubscriptionTrialEnd(sub),
                },
            });

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            const sub = event.data.object as unknown as Record<string, unknown>;
            const customerId = sub.customer as string;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            const subPlan = resolvePlan(sub);
            if (!subPlan) {
                logger.warn('Could not determine plan from subscription; leaving the stored plan unchanged', {
                    component: 'billing', subscriptionId: sub.id as string, stripeCustomerId: customerId,
                });
            }

            await db.billingAccount.update({
                where: { stripeCustomerId: customerId },
                data: {
                    stripeSubscriptionId: sub.id as string,
                    ...(subPlan ? { plan: subPlan } : {}),
                    status: mapStripeStatus(sub.status as string),
                    currentPeriodEnd: getSubscriptionPeriodEnd(sub),
                    trialEndsAt: getSubscriptionTrialEnd(sub),
                },
            });

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        case 'customer.subscription.deleted': {
            const sub = event.data.object as unknown as Record<string, unknown>;
            const customerId = sub.customer as string;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // `plan: 'FREE'` is the fix for the defect this branch used to
            // carry: it set the STATUS to CANCELED and left `plan` alone, but
            // `getEffectivePlan()` reads `plan`, not status — and deliberately
            // so, per its own docblock: "Status is INTENTIONALLY NOT YET
            // ENFORCED here ... The webhook handler is responsible for
            // downgrading the row to FREE when the period ends."
            //
            // That handler is this one, and it never did. `plan: 'FREE'` was
            // written in exactly one place in this module — at account
            // creation — so once a tenant reached PRO no code path returned
            // them to FREE. Cancelling kept the paid entitlements forever.
            //
            // This fires at the right moment by construction: with
            // `cancel_at_period_end`, Stripe sends `customer.subscription.
            // updated` immediately and `customer.subscription.deleted` only
            // when the period actually ends — which is exactly the boundary
            // the entitlements docblock describes.
            await db.billingAccount.update({
                where: { stripeCustomerId: customerId },
                data: {
                    plan: 'FREE',
                    status: 'CANCELED',
                    stripeSubscriptionId: null,
                    currentPeriodEnd: null,
                },
            });

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        case 'invoice.payment_failed': {
            const invoice = event.data.object as unknown as Record<string, unknown>;
            const customerId = (invoice.customer ?? invoice.customer_id) as string;
            if (!customerId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // Mark account as PAST_DUE on payment failure
            await db.billingAccount.update({
                where: { stripeCustomerId: customerId },
                data: { status: 'PAST_DUE' },
            });

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            logger.warn('Payment failed', { component: 'billing', stripeCustomerId: customerId, tenantId: billingAccount.tenantId });
            break;
        }

        case 'invoice.payment_succeeded': {
            const invoice = event.data.object as unknown as Record<string, unknown>;
            const customerId = (invoice.customer ?? invoice.customer_id) as string;
            if (!customerId) break;

            const billingAccount = await db.billingAccount.findUnique({
                where: { stripeCustomerId: customerId },
            });
            if (!billingAccount) break;

            // Re-activate if was PAST_DUE
            if (billingAccount.status === 'PAST_DUE') {
                await db.billingAccount.update({
                    where: { stripeCustomerId: customerId },
                    data: { status: 'ACTIVE' },
                });
            }

            await db.billingEvent.create({
                data: {
                    tenantId: billingAccount.tenantId,
                    type: event.type,
                    stripeEventId: event.id,
                    payloadJson: JSON.parse(JSON.stringify(event.data.object)),
                },
            });
            break;
        }

        default:
            // Unhandled event type — log but don't process
            logger.debug('Unhandled event type', { component: 'billing', eventType: event.type });
            break;
    }
}

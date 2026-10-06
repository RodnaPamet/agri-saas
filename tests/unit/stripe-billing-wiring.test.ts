/**
 * The three things that had to be true before Stripe goes live.
 *
 * Billing is currently dormant — `STRIPE_SECRET_KEY` is absent from the VM, so
 * `getStripe()` throws on first call and none of this runs in production yet.
 * That is exactly why it is worth fixing now: every defect below is free today
 * and expensive the week money starts moving.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

// A row to mutate, plus recorders for what the handler writes.
const account = {
    id: 'ba_1',
    tenantId: 'tenant_1',
    stripeCustomerId: 'cus_1',
    plan: 'PRO',
    status: 'ACTIVE',
};
const updates: Array<Record<string, unknown>> = [];

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        billingEvent: {
            findUnique: jest.fn(async () => null), // never a duplicate
            create: jest.fn(async () => ({})),
        },
        billingAccount: {
            findUnique: jest.fn(async () => account),
            update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
                updates.push(data);
                return account;
            }),
        },
    },
}));

const warnings: unknown[] = [];
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn((...a: unknown[]) => warnings.push(a)),
        error: jest.fn(),
    },
}));

import { handleWebhookEvent } from '@/lib/stripe';
import type Stripe from 'stripe';

/** A subscription event shaped the way Stripe sends it. */
const subEvent = (
    type: string,
    sub: Record<string, unknown>,
): Stripe.Event =>
    ({
        id: `evt_${Math.random().toString(36).slice(2)}`,
        type,
        data: { object: { customer: 'cus_1', id: 'sub_1', status: 'active', ...sub } },
    }) as unknown as Stripe.Event;

beforeEach(() => {
    updates.length = 0;
    warnings.length = 0;
    process.env.STRIPE_PRICE_ID_PRO = 'price_pro';
    process.env.STRIPE_PRICE_ID_ENTERPRISE = 'price_ent';
});

describe('cancelling actually downgrades the plan', () => {
    it('customer.subscription.deleted writes plan FREE, not just status CANCELED', async () => {
        // THE DEFECT. This branch set `status: 'CANCELED'` and left `plan`
        // alone — but `getEffectivePlan()` reads `plan`, not status, and says
        // so in its own docblock: "Status is INTENTIONALLY NOT YET ENFORCED
        // here ... The webhook handler is responsible for downgrading the row
        // to FREE when the period ends." This handler never did, and `plan:
        // 'FREE'` was written in exactly one place in the module — at account
        // creation. So cancelling kept PRO entitlements indefinitely.
        await handleWebhookEvent(subEvent('customer.subscription.deleted', {}));

        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
            plan: 'FREE',
            status: 'CANCELED',
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
        });
    });
});

describe('the plan is resolved, never guessed', () => {
    it('uses metadata.plan — what our own checkout stamps', async () => {
        await handleWebhookEvent(
            subEvent('customer.subscription.updated', { metadata: { plan: 'ENTERPRISE' } }),
        );
        expect(updates[0]).toMatchObject({ plan: 'ENTERPRISE' });
    });

    it('falls back to the PRICE id for a subscription made outside our checkout', async () => {
        // A subscription created in the Stripe dashboard carries no metadata.
        await handleWebhookEvent(
            subEvent('customer.subscription.updated', {
                metadata: {},
                items: { data: [{ price: { id: 'price_ent' } }] },
            }),
        );
        expect(updates[0]).toMatchObject({ plan: 'ENTERPRISE' });
    });

    it('leaves the stored plan ALONE when it cannot tell, and says so', async () => {
        // This used to `return 'PRO'`. An unrecognised subscription silently
        // granted the PRO plan — guessing in the customer's favour, which is
        // the expensive direction to guess in.
        await handleWebhookEvent(
            subEvent('customer.subscription.updated', {
                metadata: {},
                items: { data: [{ price: { id: 'price_someone_elses' } }] },
            }),
        );
        expect(updates).toHaveLength(1);
        expect(updates[0]).not.toHaveProperty('plan');
        expect(warnings).toHaveLength(1);
    });

    it('an unknown price does not become PRO by accident', async () => {
        await handleWebhookEvent(
            subEvent('customer.subscription.updated', { metadata: {}, items: { data: [] } }),
        );
        expect(updates[0]).not.toHaveProperty('plan');
    });
});

describe('the Stripe API version is pinned, and loudly', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/stripe.ts'), 'utf8');

    it('getStripe passes an explicit apiVersion', () => {
        // Without it the SDK's default decides which API production talks to,
        // so an SDK major silently changes payment behaviour. stripe@23 moved
        // that default; #1309 landed it while billing was dormant, which is the
        // only reason it cost nothing.
        expect(src).toMatch(/new Stripe\(key, \{ apiVersion: STRIPE_API_VERSION \}\)/);
    });

    it('the pin matches the INSTALLED SDK, so an upgrade fails loudly', () => {
        // The SDK types apiVersion as `typeof ApiVersion` — a single literal —
        // so a future major stops compiling rather than silently moving. This
        // case is the same claim at test level: if it fails after a bump, that
        // is the signal to re-read the API changelog, not to edit the string.
        const pinned = /const STRIPE_API_VERSION = '([^']+)'/.exec(src)?.[1];
        expect(pinned).toBeTruthy();

        const sdk = fs.readFileSync(
            path.join(ROOT, 'node_modules/stripe/cjs/apiVersion.js'),
            'utf8',
        );
        expect(sdk).toContain(pinned!);
    });
});

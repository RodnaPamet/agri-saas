/**
 * The pending-invite list distinguishes "bounced" from "still waiting" (#1769).
 *
 * ## What was wrong
 *
 * A bounced invite and an unopened one were the same row. The phone's Члене
 * screen lists pending invitations and renders «Поканен» for each; agrent-ios
 * records that "has my invite actually gone out?" is the main reason anyone
 * opens that screen. So the one question it exists to answer was answered
 * wrongly, confidently, for every invite whose email never arrived.
 *
 * ## Why the field is MAPPED rather than passed through
 *
 * The column stores the provider's event type — `email.bounced`. Resend's
 * vocabulary is not this API's, and a client switching on it would break when
 * the provider renames an event. `inviteDelivery` is the stable token.
 *
 * ## The assertion that matters most is the UNRECOGNISED case
 *
 * `null` means "nothing has come back", which is materially different from
 * "something came back that we cannot name". If an unknown event mapped to
 * null it would render as «Поканен» — the exact bug this field exists to fix,
 * reintroduced for precisely the events nobody anticipated. So an unknown kind
 * must still produce a token.
 */
import { makeRequestContext } from '../helpers/make-context';

const findMany = jest.fn();
const mockDb = { tenantInvite: { findMany } };

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

import { listPendingInvites } from '@/app-layer/usecases/tenant-invites';

const ctx = makeRequestContext('OWNER');
const FAILED_AT = new Date('2026-10-20T09:30:00.000Z');

/** One row as Prisma would return it, with the delivery columns set. */
const row = (deliveryFailureKind: string | null, deliveryFailedAt: Date | null = null) => ({
    id: 'inv_1',
    tenantId: 't_1',
    email: 'a@b.test',
    role: 'READER',
    expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    invitedBy: { id: 'u_1', name: 'Dana' },
    deliveryFailureKind,
    deliveryFailedAt,
});

beforeEach(() => findMany.mockReset());

describe('the pending-invite list reports delivery', () => {
    it('selects the delivery columns at all', async () => {
        findMany.mockResolvedValue([]);
        await listPendingInvites(ctx);
        const select = findMany.mock.calls[0][0].select as Record<string, unknown>;
        // Without these in the SELECT the mapping below reads undefined and
        // every invite reports "nothing came back", whatever the row says.
        expect(Object.keys(select)).toContain('deliveryFailureKind');
        expect(Object.keys(select)).toContain('deliveryFailedAt');
    });

    it('maps a bounce to a stable token, with the time it was learned', async () => {
        findMany.mockResolvedValue([row('email.bounced', FAILED_AT)]);
        const [out] = await listPendingInvites(ctx);
        expect(out.inviteDelivery).toBe('BOUNCED');
        expect(out.inviteDeliveryAt).toEqual(FAILED_AT);
    });

    it('maps a complaint distinctly — it is not a bounce', async () => {
        findMany.mockResolvedValue([row('email.complained', FAILED_AT)]);
        const [out] = await listPendingInvites(ctx);
        // An enum-shaped string rather than a boolean exists for exactly this:
        // a client can tell the two apart without a second field.
        expect(out.inviteDelivery).toBe('COMPLAINED');
    });

    it('reports null ONLY when nothing has come back', async () => {
        findMany.mockResolvedValue([row(null)]);
        const [out] = await listPendingInvites(ctx);
        expect(out.inviteDelivery).toBeNull();
        expect(out.inviteDeliveryAt).toBeNull();
    });

    it('still reports a token for an event type nobody anticipated', async () => {
        findMany.mockResolvedValue([row('email.some_future_failure', FAILED_AT)]);
        const [out] = await listPendingInvites(ctx);
        // NOT null. Null would render as "still pending" for a message the
        // provider told us had failed.
        expect(out.inviteDelivery).not.toBeNull();
        expect(out.inviteDelivery).toBe('SOME_FUTURE_FAILURE');
    });

    it('never reports an empty token, even for a punctuation-only kind', async () => {
        findMany.mockResolvedValue([row('...', FAILED_AT)]);
        const [out] = await listPendingInvites(ctx);
        // An empty string is falsy and would read as "no failure" at every
        // call site that checks truthiness.
        expect(out.inviteDelivery).toBe('UNKNOWN');
    });

    it('does not leak the provider vocabulary or the raw columns', async () => {
        findMany.mockResolvedValue([row('email.bounced', FAILED_AT)]);
        const [out] = await listPendingInvites(ctx);
        expect(out).not.toHaveProperty('deliveryFailureKind');
        expect(out).not.toHaveProperty('deliveryFailedAt');
        expect(JSON.stringify(out)).not.toContain('email.bounced');
    });
});

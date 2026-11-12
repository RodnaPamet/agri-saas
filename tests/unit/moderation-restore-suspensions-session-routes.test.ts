/**
 * The session-authenticated restore and suspension routes — #2735, PR 3.
 *
 * These are the last two moderation surfaces that could attribute no further
 * than `platform-key:<generation>`. A reversal and a suspension are both
 * decisions about a person — an appeal upheld, or a farm withheld — and until
 * this they were recorded as having been made by whoever held the shared key.
 *
 * Six properties, and the first is the only one no response can show:
 *
 *   1. the `ModerationActor` is `{ kind: 'user' }` carrying `ctx.userId`.
 *   2. a body supplying an actor cannot override it. (1) alone would pass for a
 *      route that merely DEFAULTED it, which is the weakness the keyed sibling
 *      actually has for `reviewedBy`.
 *   3. both gates run — `admin.manage` AND `assertPlatformSupport`.
 *   4. a missing subject is a 404 and not a 200 over a no-op. Both usecases
 *      REPORT that rather than throwing, so a route returning the result
 *      unexamined would answer success for a suspension of nobody.
 *   5. the idempotent repeat is a SUCCESS, not a 404 — `applied: true` with
 *      `alreadySuspended: true`.
 *   6. DELETE takes the id in a BODY, never the URL (P5.2b: iOS logs the full
 *      URL unsuppressably).
 */
import type { NextRequest } from 'next/server';

const permissionKeys: string[] = [];
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission:
        (key: string, handler: unknown) =>
        async (req: unknown, routeArgs: { params: unknown }) => {
            permissionKeys.push(key);
            const params = await routeArgs.params;
            return (handler as (r: unknown, a: unknown, ctx: unknown) => Promise<unknown>)(
                req,
                { ...routeArgs, params },
                { userId: 'u-moderator', tenantId: 't-platform', tenantSlug: 'platform' },
            );
        },
}));

const assertPlatformSupport = jest.fn();
jest.mock('@/lib/auth/platform-support', () => ({
    assertPlatformSupport: (...a: unknown[]) => assertPlatformSupport(...a),
    isPlatformTenant: () => true,
}));

const restoreRemovedContent = jest.fn();
jest.mock('@/app-layer/usecases/moderation', () => ({
    restoreRemovedContent: (...a: unknown[]) => restoreRemovedContent(...a),
}));

const suspendAccount = jest.fn();
const liftSuspension = jest.fn();
jest.mock('@/app-layer/usecases/account-suspension', () => ({
    suspendAccount: (...a: unknown[]) => suspendAccount(...a),
    liftSuspension: (...a: unknown[]) => liftSuspension(...a),
}));

/**
 * `withApiErrorHandling` reads `req.headers.get(...)` and `req.nextUrl`, so a
 * bare `{ url, json }` throws a TypeError inside the wrapper before any handler
 * runs — which is how a shapeless `rejects.toThrow()` passes for the wrong
 * reason.
 */
function makeReq(path: string, body?: unknown, method = 'POST'): NextRequest {
    const url = new URL(`http://localhost:3000${path}`);
    return {
        method,
        headers: new Headers(),
        nextUrl: url,
        url: url.toString(),
        json: async () => body,
    } as unknown as NextRequest;
}

const params = { params: Promise.resolve({ tenantSlug: 'platform' }) };

beforeEach(() => {
    permissionKeys.length = 0;
    jest.resetAllMocks();
    restoreRemovedContent.mockResolvedValue({ restoreActionId: 'ma-restore', restored: true });
    suspendAccount.mockResolvedValue({ applied: true, sessionsRevoked: 2, alreadySuspended: false });
    liftSuspension.mockResolvedValue({ applied: true, wasSuspended: true });
});

describe('#2735 PR3 — restore', () => {
    const path = '/api/t/platform/admin/moderation/restore';
    const load = () => import('@/app/api/t/[tenantSlug]/admin/moderation/restore/route');

    it('hands the usecase an actor of kind `user` carrying ctx.userId', async () => {
        const { POST } = await load();
        const res = await POST(
            makeReq(path, { actionId: 'ma-1', rationale: 'appeal upheld' }),
            params,
        );
        expect(res.status).toBe(200);
        const arg = restoreRemovedContent.mock.calls[0][0] as { actor: unknown };
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
    });

    it('IGNORES an actor supplied in the body', async () => {
        const { POST } = await load();
        await POST(
            makeReq(path, {
                actionId: 'ma-1',
                rationale: 'r',
                actor: { kind: 'user', userId: 'u-somebody-else' },
                generation: 'previous',
            }),
            params,
        );
        const arg = restoreRemovedContent.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
        expect(arg.generation).toBeUndefined();
    });

    it('runs BOTH gates', async () => {
        const { POST } = await load();
        await POST(makeReq(path, { actionId: 'ma-1', rationale: 'r' }), params);
        expect(permissionKeys).toEqual(['admin.manage']);
        expect(assertPlatformSupport).toHaveBeenCalledTimes(1);
    });

    it('404s when the action does not exist', async () => {
        // Reported as a NULL id rather than thrown, so an unexamined result
        // would answer 200 over a restore that never happened.
        restoreRemovedContent.mockResolvedValue({ restoreActionId: null, restored: false });
        const { POST } = await load();
        const res = await POST(makeReq(path, { actionId: 'ma-gone', rationale: 'r' }), params);
        expect(res.status).toBe(404);
    });

    it('`restored: false` with a real id is a SUCCESS, not an error', async () => {
        // The idempotent repeat: already visible. A console treating this as a
        // failure would make a double submit look broken.
        restoreRemovedContent.mockResolvedValue({ restoreActionId: 'ma-r', restored: false });
        const { POST } = await load();
        const res = await POST(makeReq(path, { actionId: 'ma-1', rationale: 'r' }), params);
        expect(res.status).toBe(200);
    });

    it('refuses a body with no rationale', async () => {
        const { POST } = await load();
        const res = await POST(makeReq(path, { actionId: 'ma-1' }), params);
        expect(res.status).toBe(400);
        expect(restoreRemovedContent).not.toHaveBeenCalled();
    });
});

describe('#2735 PR3 — suspensions', () => {
    const path = '/api/t/platform/admin/moderation/suspensions';
    const load = () => import('@/app/api/t/[tenantSlug]/admin/moderation/suspensions/route');

    it('suspend hands the usecase a `user` actor and the pasted userId', async () => {
        const { POST } = await load();
        const res = await POST(
            makeReq(path, { userId: 'u-target', reason: 'repeated misleading listings' }),
            params,
        );
        expect(res.status).toBe(200);
        const arg = suspendAccount.mock.calls[0][0] as { actor: unknown; userId: string };
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
        // The TARGET comes from the body; the ACTOR never does.
        expect(arg.userId).toBe('u-target');
    });

    it('suspend refuses a body with no reason', async () => {
        // REQUIRED since #1667: it is the rationale the Art 17 statement is
        // composed from, and a decision that withholds a farm is not
        // recordable without one.
        const { POST } = await load();
        const res = await POST(makeReq(path, { userId: 'u-target' }), params);
        expect(res.status).toBe(400);
        expect(suspendAccount).not.toHaveBeenCalled();
    });

    it('suspend 404s for an account that does not exist', async () => {
        suspendAccount.mockResolvedValue({
            applied: false, sessionsRevoked: 0, alreadySuspended: false,
        });
        const { POST } = await load();
        const res = await POST(makeReq(path, { userId: 'u-nobody', reason: 'r' }), params);
        expect(res.status).toBe(404);
    });

    it('suspend treats the idempotent repeat as a SUCCESS', async () => {
        // `applied: true` WITH `alreadySuspended: true`. This is the case a
        // second clause on `alreadySuspended` would have been written for — and
        // such a clause is vacuous, because `applied: false` means no such user
        // and nothing else. My first draft had one.
        suspendAccount.mockResolvedValue({
            applied: true, sessionsRevoked: 0, alreadySuspended: true,
        });
        const { POST } = await load();
        const res = await POST(makeReq(path, { userId: 'u-target', reason: 'r' }), params);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ alreadySuspended: true });
    });

    it('lift hands a `user` actor and takes the id from the BODY', async () => {
        const { DELETE } = await load();
        const res = await DELETE(makeReq(path, { userId: 'u-target' }, 'DELETE'), params);
        expect(res.status).toBe(200);
        const arg = liftSuspension.mock.calls[0][0] as { actor: unknown; userId: string };
        expect(arg.actor).toEqual({ kind: 'user', userId: 'u-moderator' });
        expect(arg.userId).toBe('u-target');
        // The URL carries no id — P5.2b, because iOS logs the full URL
        // unsuppressably and a third party's user id in a device log is the
        // disclosure that rule exists to prevent.
        expect(path).not.toContain('u-target');
    });

    it('lift 404s for an account that does not exist', async () => {
        // Missing from my first draft: lifting nobody answered 200.
        liftSuspension.mockResolvedValue({ applied: false, wasSuspended: false });
        const { DELETE } = await load();
        const res = await DELETE(makeReq(path, { userId: 'u-nobody' }, 'DELETE'), params);
        expect(res.status).toBe(404);
    });

    it('lift treats `wasSuspended: false` as a SUCCESS', async () => {
        // Lifting a suspension that was not there is idempotent, and is a
        // different thing from the account not existing.
        liftSuspension.mockResolvedValue({ applied: true, wasSuspended: false });
        const { DELETE } = await load();
        const res = await DELETE(makeReq(path, { userId: 'u-target' }, 'DELETE'), params);
        expect(res.status).toBe(200);
    });

    it('lift passes EXACTLY userId and actor — nothing from the body leaks through', async () => {
        const { DELETE } = await load();
        await DELETE(makeReq(path, { userId: 'u-target', reason: 'ignored' }, 'DELETE'), params);
        const arg = liftSuspension.mock.calls[0][0] as Record<string, unknown>;

        // My first version asserted only `arg.reason === undefined` and
        // credited `.strip()` for it. A mutation declaring `reason` on
        // `LiftBody` SURVIVED, which is how I found that wrong: `.strip()`
        // removes UNKNOWN keys, so a DECLARED one passes it. What actually
        // prevents the leak is that the route constructs the call with explicit
        // fields and never spreads the parsed body.
        //
        // So assert the real property — the exact key set — which fails on a
        // future `...input` spread as well as on a widened schema. `reason` is
        // deliberately absent because lifting is not a decision the Art 17
        // machinery composes a statement from.
        expect(Object.keys(arg).sort()).toEqual(['actor', 'userId']);
    });
});

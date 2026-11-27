/**
 * Session revocation — #3080.
 *
 * Three routes that all do the same underlying thing and read as if they do
 * three different things. Documenting them is mostly a matter of saying what
 * the names do not.
 *
 * **`sessionVersion` is PLATFORM-WIDE.** Every one of these bumps a counter on
 * the `User` row, and `src/app-layer/usecases/session-security.ts` says the
 * consequence in its own comment: "this signs the person out of EVERY farm
 * they belong to". So a farm admin revoking a member's sessions ends their
 * sessions in farms this farm has nothing to do with. That is deliberate and
 * already bounded — #3214 narrowed both admin routes to ACTIVE members,
 * because repeating a revoke against somebody the farm had let go "signed an
 * ex-member out of their own farms over and over" — but it is invisible from
 * the route names, which is the whole reason this file exists.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '@/lib/openapi/zod';
import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

/** The shared caveat, so three descriptions cannot drift about it. */
const PLATFORM_WIDE =
    '\n\n**This is PLATFORM-WIDE, not farm-scoped.** Revocation increments '
    + '`User.sessionVersion`, which every farm\'s session check reads — so the person '
    + 'is signed out of EVERY farm they belong to, including ones this farm has no '
    + 'relationship with. Both admin routes are narrowed to ACTIVE members (#3214) so '
    + 'a former member cannot be signed out of their own farms by a farm that let them '
    + 'go, but within that bound the effect is global to the person.';

export function registerSessionRevocationPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/security/sessions/revoke-current',
        operationId: 'revokeCurrentUserSessions',
        summary: 'Sign yourself out of every session',
        description:
            '**The name is misleading and the behaviour is the broader one.** Despite '
            + '"current", this revokes ALL of the caller\'s sessions — the usecase is '
            + 'literally `revokeUserSessions(ctx, ctx.userId)`, identical to an admin '
            + 'aiming the admin route at you. The response message says so ("All your '
            + 'sessions have been revoked"); the route name does not.'
            + '\n\n**There is NO single-session revocation anywhere in this API.** If you '
            + 'are building a "sign out this device" affordance, this route is not it and '
            + 'nothing else is either — see #3080\'s notes. Label the control accordingly '
            + '("sign out everywhere") rather than implying one device.'
            + '\n\nThe only route of the three with NO permission gate: any member may end '
            + 'their own sessions, which is correct — a way out must not require a '
            + 'privilege.'
            + PLATFORM_WIDE,
        tags: ['Security'],
        params: TenantParams,
        success: {
            status: 200,
            description:
                'Revoked. `newSessionVersion` is the counter every session check now '
                + 'compares against, so any token minted before it is dead.',
            schema: z.object({
                success: z.boolean(),
                message: z.string(),
                userId: z.string(),
                newSessionVersion: z.number().int(),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/security/sessions/revoke-user',
        operationId: 'revokeUserSessions',
        summary: 'Sign one member out of every session',
        description:
            'Requires `admin.members` — it is a member-management action, not a security '
            + 'console one.'
            + '\n\n**`targetUserId` is OPTIONAL, and omitting it revokes YOUR OWN '
            + 'sessions.** The schema says "if absent, revoke current user\'s sessions", '
            + 'so a client that fails to send the field does not get an error — it signs '
            + 'the caller out instead, which is indistinguishable from the request having '
            + 'worked until the admin finds themselves logged out. Always send it '
            + 'explicitly.'
            + '\n\nRefuses a member who is not ACTIVE with `TARGET_USER_NOT_IN_TENANT` — '
            + 'a 404 rather than a 403, so the response does not confirm that an id names '
            + 'a real person elsewhere.'
            + PLATFORM_WIDE,
        tags: ['Security'],
        params: TenantParams,
        body: z.object({
            targetUserId: z.string().optional().openapi({
                description:
                    'The member to sign out. OPTIONAL in the schema, and absent means the '
                    + 'CALLER — send it explicitly.',
            }),
        }),
        extraResponses: codedErrorResponses({
            403: '`ADMIN_REQUIRED` — the caller lacks `admin.members`.',
            404: '`TARGET_USER_NOT_IN_TENANT` — not an ACTIVE member of this farm.',
        }),
        success: {
            status: 200,
            description: 'Revoked.',
            schema: z.object({
                success: z.boolean(),
                message: z.string(),
            }).passthrough(),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/security/sessions/revoke-all',
        operationId: 'revokeAllTenantSessions',
        summary: 'Sign every member of the farm out',
        description:
            'Requires `admin.members`. The blunt instrument — for a suspected '
            + 'compromise, not for routine member management.'
            + '\n\n**`usersAffected` counts ACTIVE members, which is the population it '
            + 'acted on** (#3214). A farm with no active members returns `0` rather than '
            + 'failing, so zero means "nobody to sign out", not "nothing happened for '
            + 'some other reason".'
            + '\n\nEvery one of those people is signed out of their OTHER farms too, so '
            + 'the reach of this button is larger than the farm pressing it. A client '
            + 'should say so in the confirmation rather than describing it as signing out '
            + '"this farm".'
            + PLATFORM_WIDE,
        tags: ['Security'],
        params: TenantParams,
        extraResponses: codedErrorResponses({
            403: '`ADMIN_REQUIRED` — the caller lacks `admin.members`.',
        }),
        success: {
            status: 200,
            description: 'Revoked for every ACTIVE member.',
            schema: z.object({
                success: z.boolean(),
                message: z.string(),
                usersAffected: z.number().int(),
            }),
        },
    });
}

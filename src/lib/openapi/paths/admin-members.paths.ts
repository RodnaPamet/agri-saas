/**
 * `/admin/members` and `/admin/invites` — who can reach this farm, and at
 * what level.
 *
 * Thirteen operations across ten route files, every one of them gated on
 * `admin.members`, and **none of them documented until now** (the last open
 * item on #1391). A client has had to learn this surface by calling it, which
 * is survivable for shapes and not survivable for the six behaviours below:
 * each one is something a measured response cannot tell you, because the
 * evidence is an absence, a name that means the opposite of what it says, or a
 * value that is identical in two different situations.
 *
 * ── 1. Two paths return the identical invite list ──
 *
 * `GET /admin/invites` and `GET /admin/members?view=invites` both call
 * `listPendingInvites(ctx)` and both `jsonResponse(invites)` — byte for byte
 * the same. A client measuring one has no way to discover the other exists, or
 * that they agree. Documented as the same list rather than left for each
 * client to find, because the redundancy is the kind that diverges silently:
 * a change to one handler would break the other's callers with nothing
 * failing.
 *
 * ── 2. `GET /admin/members` is not a roster ──
 *
 * It returns `ACTIVE`, `INVITED` and `DEACTIVATED`. So `status` is
 * load-bearing, not decoration, and a client rendering the list as "current
 * staff" shows deactivated people with no indication.
 *
 * This is INTENDED and a client relies on it: agrent-ios groups the rows by
 * status, offers «Активирай» on a deactivated one, and counts every row
 * deliberately so the number on its admin screen matches the list behind it.
 * Documented as contract, therefore, not as a caveat.
 *
 * `REMOVED` is EXCLUDED — which is the half that surprises. `DELETE` sets that
 * status precisely so the row leaves this list, so "removed" is an absence
 * here and never a value you can display. (agrent-ios had a grouping bucket
 * for it that could never fill; it cannot be fed from this endpoint.)
 *
 * For a roster of people to assign work to, use the assignable-users endpoint
 * instead: `ACTIVE` only, no session counts, and readable by any signed-in
 * member rather than admins alone.
 *
 * ── 3. An expired invite VANISHES rather than expiring ──
 *
 * `listPendingInvites` filters `acceptedAt: null`, `revokedAt: null` AND
 * `expiresAt > now`. So an invite leaves the list for THREE different reasons
 * and all three present identically: as absence. "Never invited", "invite
 * expired" and "invite withdrawn" are indistinguishable from this endpoint.
 *
 * Worth stating because the obvious client behaviour — offer to re-invite when
 * absent — is right for all three, while the obvious client COPY ("no pending
 * invites") is misleading for the expired case. There is no `expired` state to
 * render; if one is wanted it is a server change.
 *
 * ── 4. `bulk/delete` DEACTIVATES. `bulk/remove` removes. ──
 *
 * The two bulk paths are named inversely to their severity:
 *
 *     POST /admin/members/bulk/remove   → `{ removed, skipped }`      REMOVED
 *     POST /admin/members/bulk/delete   → `{ deactivated, skipped }`  DEACTIVATED
 *
 * `bulk/delete` is the bulk counterpart of `POST …/{id}/deactivate`, not of
 * `DELETE …/{id}`. A client reasoning from the path names picks the wrong one,
 * and both directions of that mistake are plausible — "delete" reads as the
 * harder action and is the softer one. The names are what they are; this is
 * the documentation saying so loudly.
 *
 * ── 5. `activeSessionCount: 0` means "none" OR "could not tell" ──
 *
 * The count comes from a best-effort read of the session tracker, wrapped so
 * that a database failure yields `{}` and the page degrades rather than
 * failing. The degraded value is `0` per member, indistinguishable from a
 * member who genuinely has no live session. A client showing "0 active
 * sessions" as a fact is reporting an unknown as a zero.
 *
 * ── 6. `POST /admin/members` and `POST /admin/invites` are the same operation ──
 *
 * Both create an invite through the same usecase, send the same email, and
 * return the same `201 { invite, url, emailSent }`. They now also share ONE
 * 20/hr rate-limit budget, keyed per tenant (#1448 — `/admin/members` had no
 * limit at all, so the control was bypassed by changing the path). Twenty
 * invites through either door in an hour exhausts both.
 *
 * `emailSent` is the field that makes this surface honest: the invite row is
 * committed before the mail is attempted and a mailer failure never fails
 * creation, so `201` with `emailSent: false` is a real and expected outcome.
 * `url` is the copy-paste fallback for exactly that case.
 *
 * @module lib/openapi/paths/admin-members
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { op } from './helpers';
import {
    InviteMemberSchema,
    UpdateAdminMemberSchema,
    UpdateMemberCertificatesSchema,
    CreateAdminInviteSchema,
    BulkRemoveMembershipsSchema,
    BulkDeactivateMembershipsSchema,
    BulkRevokeInvitesSchema,
} from '@/lib/schemas';

/** The six tenant roles assignable by hand. */

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' }, example: 'acme' }),
});

const MembershipParams = TenantParams.extend({
    membershipId: z.string().openapi({ param: { name: 'membershipId', in: 'path' } }),
});

const InviteParams = TenantParams.extend({
    inviteId: z.string().openapi({ param: { name: 'inviteId', in: 'path' } }),
});

const MemberUserSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
    createdAt: z.string().datetime(),
});

const AdminMemberSchema = z
    .object({
        id: z.string().openapi({ description: 'The MEMBERSHIP id — this is what every other operation here takes, not the user id.' }),
        tenantId: z.string(),
        userId: z.string(),
        role: z.string().openapi({
            description:
                'The enum role. A growing union — treat an unrecognised value as the least privilege rather than as an error. When `customRole` is set, THIS field is the base and the custom role overrides it.',
        }),
        customRoleId: z.string().nullable(),
        customRole: z
            .object({ id: z.string(), name: z.string() })
            .nullable()
            .openapi({ description: 'Granular overrides on top of `role`. Null for the great majority of members.' }),
        status: z.string().openapi({
            description:
                '`ACTIVE`, `INVITED` or `DEACTIVATED`. **Load-bearing, not decoration** — this list deliberately includes deactivated members. `REMOVED` never appears: that status exists so the row leaves this list.',
        }),
        invitedAt: z.string().datetime().nullable(),
        invitedByUserId: z.string().nullable(),
        invitedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
        deactivatedAt: z.string().datetime().nullable(),
        applicatorCertNo: z.string().nullable().openapi({
            description: 'БАБХ plant-protection applicator certificate. Written by the `certificates` PUT, not by role edits.',
        }),
        agronomistCertNo: z.string().nullable(),
        agronomistName: z.string().nullable(),
        provisionedByOrgId: z.string().nullable().openapi({
            description: 'Set when the membership came from an organisation provisioning run rather than a manual invite.',
        }),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        user: MemberUserSchema,
        activeSessionCount: z.number().int().openapi({
            description:
                'Live sessions for this member. **A best-effort figure: `0` means "none" OR "the session store could not be read".** The read is wrapped so a failure degrades the page rather than failing it, and the degraded value is 0 for every member. Render it as a fact only if that ambiguity is acceptable; prefer showing nothing at 0.',
        }),
    })
    .openapi('AdminMember');

const PendingInviteSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        email: z.string(),
        role: z.string(),
        expiresAt: z.string().datetime().openapi({
            description:
                'When the invite stops appearing in this list. There is no `expired` state to observe — see the endpoint description.',
        }),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
        invitedBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
    })
    .openapi('PendingInvite', {
        description:
            'A pending invite. Deliberately carries NO acceptance token: the token is a bearer credential and belongs only in the `url` the create response returns (#1450).',
    });

const InviteCreatedSchema = z
    .object({
        invite: PendingInviteSchema,
        url: z.string().openapi({
            description:
                'The acceptance link, token included. The ONLY place the token is returned. Treat it as a credential: do not log it, and do not put it anywhere a URL is recorded.',
        }),
        emailSent: z.boolean().openapi({
            description:
                '**`false` is a real and expected outcome of a 201.** The invite row is committed before the mail is attempted and a mailer failure never fails creation, so a `201 { emailSent: false }` means "the invite exists, nobody was told" — show the admin `url` to pass on by hand.',
        }),
    })
    .openapi('InviteCreated');

const BulkResultSchema = (field: string, label: string) =>
    z.object({
        [field]: z.number().int().openapi({ description: `How many memberships were ${label}.` }),
        skipped: z.number().int().openapi({
            description:
                'How many were left alone — already in the target state, or refused by an invariant (self, or the last active OWNER/ADMIN). A non-zero `skipped` is NOT an error and the operation is still a 200.',
        }),
    });

export function registerAdminMembersPaths(registry: OpenAPIRegistry): void {
    // ── members ──────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/members',
        operationId: 'listAdminMembers',
        summary: 'Everyone with a membership in this farm',
        description:
            '**Not a roster.** Returns `ACTIVE`, `INVITED` and `DEACTIVATED` memberships, so `status` is load-bearing: ' +
            'a client rendering this as "current staff" shows deactivated people with no indication. That inclusion is ' +
            'INTENDED and at least one client relies on it — grouping by status, offering reactivation on a deactivated ' +
            'row, and counting every row so its displayed total matches the list behind it.' +
            '\n\n**`REMOVED` is excluded.** `DELETE …/{membershipId}` sets that status precisely so the row leaves this ' +
            'list, so "removed" is an absence here and never a value to display. A UI group for it can never fill.' +
            '\n\nOrdered by `createdAt` ASCENDING — oldest membership first, so the owner tends to be row one. That is ' +
            'the opposite of the invite list, which is newest-first.' +
            '\n\n**`?view=invites` returns the PENDING INVITE list instead**, byte-identical to `GET /admin/invites`. ' +
            'It is the same usecase and the same response; neither path is deprecated and a change to one would need the ' +
            'other. Prefer `/admin/invites`, which says what it returns.' +
            '\n\nFor a list of people to assign work to, use the assignable-users endpoint rather than this one: it is ' +
            '`ACTIVE`-only, carries no session counts, and is readable by any signed-in member instead of admins alone.',
        tags: ['Admin'],
        params: TenantParams,
        query: z.object({
            view: z.literal('invites').optional().openapi({
                description:
                    'The ONLY accepted value, and it changes the response TYPE to the pending-invite list. Any other value — or none — returns members. There is no `view=members`.',
            }),
        }),
        success: {
            status: 200,
            description:
                'The farm\'s memberships, oldest first. With `?view=invites`, the pending-invite array instead.',
            // A UNION, because the route genuinely answers two shapes on one
            // status and the prose above already says so. The description is
            // read by a human; the schema is read by a GENERATOR, which is the
            // whole argument #1391 makes about `format: date-time` one level
            // down — agrent-ios hand-writes its models and was fine, and the
            // next client will not.
            //
            // `PendingInviteSchema` rather than a new one: `?view=invites`
            // calls the SAME `listPendingInvites` usecase as
            // `GET /admin/invites`, which declares `z.array(PendingInviteSchema)`
            // below. Two schemas for one usecase is how the two would drift.
            schema: z.union([z.array(AdminMemberSchema), z.array(PendingInviteSchema)]),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/members',
        operationId: 'inviteAdminMember',
        summary: 'Invite someone to the farm',
        description:
            '**Creates an INVITE, not a membership.** Nobody joins until they accept, so a 201 here does not add a row ' +
            'to `GET /admin/members` as ACTIVE — it adds one to the pending-invite list.' +
            '\n\n**Identical to `POST /admin/invites`**: same body, same usecase, same email, same response. This is the ' +
            'path the web admin UI calls. They share ONE 20/hr rate-limit budget keyed per tenant, so twenty invites ' +
            'through either door in an hour exhausts both — handle 429 with `Retry-After` on both.' +
            '\n\n**`emailSent: false` is a real outcome of a 201.** The invite is committed before the mail is attempted ' +
            'and a mailer failure never fails creation. Show the admin `url` to pass on by hand rather than reporting a ' +
            'failure, and never retry the POST on it — that mints a second invite.' +
            '\n\n`MECHANISATOR` is assignable here, and is deliberately absent from the roles an SSO/SCIM provisioning ' +
            'run may assign. Do not infer the provisionable set from this enum; the two disagree by design.',
        tags: ['Admin'],
        params: TenantParams,
        body: InviteMemberSchema,
        success: {
            status: 201,
            description: 'The invite exists. Check `emailSent` before telling the admin the person was notified.',
            schema: InviteCreatedSchema,
        },
    });

    op(registry, {
        method: 'patch',
        path: '/api/t/{tenantSlug}/admin/members/{membershipId}',
        operationId: 'updateAdminMember',
        summary: "Change a member's role",
        description:
            'Both fields are optional and they are applied INDEPENDENTLY — `role` sets the enum role, `customRoleId` ' +
            'assigns or (when `null`) unassigns a custom role.' +
            '\n\n**Sending both in one request is accepted, and the RESPONSE then describes the custom-role assignment ' +
            'rather than the role change.** The handler applies them in sequence and returns the result of whichever ran ' +
            'last. Send one field per request if you need the response to describe the change you made.' +
            '\n\n**Sending neither is a 400**, coded `NO_CHANGES_SPECIFIED`.' +
            '\n\nThat sentence previously read "the error body is not the standard `ErrorResponse` ' +
            'envelope" — which documented a defect instead of fixing it, on an operation whose 400 this ' +
            'same document declares AS `ErrorResponse`. Two adjacent fields of one spec contradicting ' +
            'each other is worse than either alone, so the route was corrected rather than the sentence ' +
            'softened (#1447).' +
            '\n\nRefusals that live in the usecase rather than the route: promoting or demoting yourself, and removing ' +
            'the role from the last active OWNER/ADMIN. A farm must never become unadministrable.',
        tags: ['Admin'],
        params: MembershipParams,
        body: UpdateAdminMemberSchema,
        success: { status: 200, description: 'The updated membership.', schema: AdminMemberSchema },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/members/{membershipId}',
        operationId: 'removeAdminMember',
        summary: 'Remove a membership from the farm',
        description:
            '**The hard one.** Sets `REMOVED`, which makes the row leave `GET /admin/members` entirely — there is no ' +
            'state to display afterwards and no documented route back. For a reversible action use ' +
            '`POST …/{membershipId}/deactivate`, which keeps the row listed as `DEACTIVATED` and has a `reactivate` ' +
            'counterpart.' +
            '\n\nSelf-removal and removing the last active OWNER/ADMIN are refused in the usecase, so a farm cannot be ' +
            'left unadministrable.' +
            '\n\nNote the asymmetry with the bulk paths: `bulk/remove` is the bulk form of THIS operation, while ' +
            '`bulk/delete` is the bulk form of `deactivate`.',
        tags: ['Admin'],
        params: MembershipParams,
        success: { status: 200, description: 'The removed membership.', schema: AdminMemberSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/members/{membershipId}/deactivate',
        operationId: 'deactivateAdminMember',
        summary: 'Suspend a member without removing them',
        description:
            'Sets `DEACTIVATED`. The row STAYS in `GET /admin/members` with that status, which is the point — the ' +
            'reversible counterpart to `DELETE`, and what an admin wants for seasonal staff.' +
            '\n\n**No request body.** Reverse it with `POST …/reactivate`.',
        tags: ['Admin'],
        params: MembershipParams,
        success: { status: 200, description: 'The deactivated membership.', schema: AdminMemberSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/members/{membershipId}/reactivate',
        operationId: 'reactivateAdminMember',
        summary: 'Restore a deactivated member',
        description:
            'Sets `ACTIVE`. **No request body.** The counterpart to `deactivate`; there is no equivalent for a ' +
            '`REMOVED` membership, which is why the two actions are not interchangeable.',
        tags: ['Admin'],
        params: MembershipParams,
        success: { status: 200, description: 'The reactivated membership.', schema: AdminMemberSchema },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/members/{membershipId}/certificates',
        operationId: 'updateAdminMemberCertificates',
        summary: "A member's БАБХ plant-protection certificates",
        description:
            'The one operation here that is not about membership lifecycle. These numbers appear on the ДНЕВНИК farm ' +
            'record, so they are regulatory data attached to a person rather than an access setting — which is why it ' +
            'lives under `/admin/members` only because that is who may edit it.' +
            '\n\n**Three-state per field, and the states are distinct**: a value SETS it, `null` CLEARS it, and omitting ' +
            'the field LEAVES IT UNCHANGED. A client sending the whole form every time will clear what it does not know ' +
            'about, so send only the fields the admin edited — or send every field explicitly, including the nulls.' +
            '\n\nA `PUT` rather than a `PATCH` despite the merge semantics; the method is what it is.',
        tags: ['Admin'],
        params: MembershipParams,
        body: UpdateMemberCertificatesSchema,
        success: { status: 200, description: 'The updated membership.', schema: AdminMemberSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/members/bulk/remove',
        operationId: 'bulkRemoveAdminMembers',
        summary: 'Remove several memberships',
        description:
            'The bulk form of `DELETE …/{membershipId}` — sets `REMOVED`, so the rows leave the members list.' +
            '\n\n**Read the sibling path before choosing between them**: `bulk/delete` does NOT remove, it deactivates. ' +
            'The two are named inversely to their severity.' +
            '\n\n1–100 ids per request. **Partial success is a 200**: `skipped` counts ids already in the target state or ' +
            'refused by an invariant (yourself, the last active OWNER/ADMIN). A non-zero `skipped` is not an error, and ' +
            'the response does not say WHICH ids were skipped — compare against the list if you need to know.',
        tags: ['Admin'],
        params: TenantParams,
        body: BulkRemoveMembershipsSchema,
        success: {
            status: 200,
            description: 'How many were removed, and how many were left alone.',
            schema: BulkResultSchema('removed', 'removed').openapi('BulkRemoveResult'),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/members/bulk/delete',
        operationId: 'bulkDeactivateAdminMembers',
        summary: 'Deactivate several memberships (the path name says delete)',
        description:
            '**This DEACTIVATES. It does not delete.** It is the bulk form of `POST …/{membershipId}/deactivate`, not of ' +
            '`DELETE …/{membershipId}`, and the response field is `deactivated` rather than `removed`. The rows stay in ' +
            '`GET /admin/members` with status `DEACTIVATED` and can be reactivated.' +
            '\n\nThe path is a misnomer this documentation cannot fix. A client reasoning from the names will pick the ' +
            'wrong one in either direction — "delete" reads as the harder action and is the softer one — so pick by the ' +
            'RESPONSE FIELD, which is unambiguous: `{ deactivated, skipped }` here, `{ removed, skipped }` on ' +
            '`bulk/remove`.' +
            '\n\n1–100 ids. Partial success is a 200; see `bulk/remove` for what `skipped` covers.',
        tags: ['Admin'],
        params: TenantParams,
        body: BulkDeactivateMembershipsSchema,
        success: {
            status: 200,
            description: 'How many were DEACTIVATED, and how many were left alone.',
            schema: BulkResultSchema('deactivated', 'deactivated').openapi('BulkDeactivateResult'),
        },
    });

    // ── invites ──────────────────────────────────────────────────────

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/invites',
        operationId: 'listAdminInvites',
        summary: 'Invites still awaiting acceptance',
        description:
            'Newest first — the opposite order to the members list.' +
            '\n\n**An invite leaves this list for three different reasons and all three look identical.** The filter is ' +
            '`acceptedAt: null` AND `revokedAt: null` AND `expiresAt > now`, so accepted, withdrawn and EXPIRED invites ' +
            'are equally absent. There is no `expired` state to render, and "never invited" is the same observation as ' +
            'all three.' +
            '\n\nThat makes the obvious client behaviour — offer to re-invite when someone is absent — correct in every ' +
            'case, while the obvious client COPY ("no pending invites") is misleading for an invite that quietly timed ' +
            'out after its seven days. If a visible expired state is wanted, it is a server change.' +
            '\n\n**Carries no acceptance token.** The token is a bearer credential valid until `expiresAt`; it is ' +
            'returned once, in the `url` of the create response (#1450). To send someone a fresh link, create a new ' +
            'invite.' +
            '\n\n`GET /admin/members?view=invites` returns this exact list from the same usecase. Prefer this path.',
        tags: ['Admin'],
        params: TenantParams,
        success: {
            status: 200,
            description: 'Pending invites, newest first. Empty when none are outstanding.',
            schema: z.array(PendingInviteSchema),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/invites',
        operationId: 'createAdminInvite',
        summary: 'Invite someone to the farm',
        description:
            '**Identical to `POST /admin/members`** — same body, same usecase, same email, same `201 { invite, url, ' +
            'emailSent }`. Neither is deprecated.' +
            '\n\nBoth share ONE **20 per hour** budget keyed on the tenant, so twenty invites through either path in an ' +
            'hour exhausts both and returns 429 with `Retry-After`. The limit is deliberately per-tenant rather than ' +
            'per-IP so that a multi-IP caller with one admin session still burns the same allowance.' +
            '\n\n**`emailSent: false` is a real outcome of a 201** — see `POST /admin/members`. Never retry the POST on ' +
            'it; that mints a second invite.',
        tags: ['Admin'],
        params: TenantParams,
        body: CreateAdminInviteSchema,
        success: {
            status: 201,
            description: 'The invite exists. Check `emailSent` before reporting the person was notified.',
            schema: InviteCreatedSchema,
        },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/invites/{inviteId}',
        operationId: 'revokeAdminInvite',
        summary: 'Withdraw a pending invite',
        description:
            'Sets `revokedAt`, so the invite leaves the pending list and its token stops working.' +
            '\n\n**Answers `204` with no body** — the only operation on this surface that does. A client expecting JSON ' +
            'gets none.' +
            '\n\nIndistinguishable afterwards from an invite that expired or was accepted: all three are simply absent ' +
            'from the list.',
        tags: ['Admin'],
        params: InviteParams,
        success: { status: 204, description: 'Withdrawn. No body.' },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/invites/bulk/delete',
        operationId: 'bulkRevokeAdminInvites',
        summary: 'Withdraw several pending invites',
        description:
            'The bulk form of `DELETE …/{inviteId}`. Unlike the member bulk paths, this one really does what its name ' +
            'suggests — invites have no deactivated state to confuse it with.' +
            '\n\n1–100 ids. Returns `{ revoked }` — a COUNT, with no `skipped` companion and no per-id detail, so an id ' +
            'that was already revoked, already accepted or never existed is simply not counted. `revoked` lower than ' +
            'the number of ids sent is not an error.',
        tags: ['Admin'],
        params: TenantParams,
        body: BulkRevokeInvitesSchema,
        success: {
            status: 200,
            description: 'How many invites were withdrawn.',
            schema: z
                .object({ revoked: z.number().int() })
                .openapi('BulkRevokeInvitesResult'),
        },
    });
}

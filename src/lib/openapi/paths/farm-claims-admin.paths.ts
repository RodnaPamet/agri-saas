/**
 * «Потвърждаване на стопанства» — the session-authenticated review queue
 * (#2963).
 *
 * Documented rather than baselined, because `openapi-paths-complete`'s
 * baseline only SHRINKS and because the two things a reader most needs here
 * are invisible from the shapes: there are TWO doors onto this queue and only
 * one of them a browser can use, and the ЕИК is SUPPLIED by the reviewer
 * rather than confirmed — which is why no endpoint here returns one.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '@/lib/openapi/zod';

import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' } }),
});

const ClaimParams = TenantParams.extend({
    claimId: z.string().openapi({ param: { name: 'claimId', in: 'path' } }),
});

const ClaimRow = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        tenantName: z.string().nullable().openapi({
            description:
                'NULL when the tenant row is gone. A claim outlives its farm, and a blank '
                + 'name in a console reads as a rendering fault rather than a deleted farm, '
                + 'so the client renders that case explicitly.',
        }),
        tenantSlug: z.string().nullable(),
        status: z.enum(['PENDING', 'VERIFIED', 'DISPUTED']).openapi({
            description:
                'The Prisma enum has a FOURTH member, `REJECTED`, which nothing in this '
                + 'product writes or reads — see the issue linked from '
                + '`farm-identity-review.ts`. It is deliberately absent here rather than '
                + 'offered as a filter nothing can produce.',
        }),
        claimedByUserId: z.string(),
        createdAt: z.string().datetime({ offset: true }),
        verifiedAt: z.string().datetime({ offset: true }).nullable(),
        disputedAt: z.string().datetime({ offset: true }).nullable(),
    })
    .openapi('FarmIdentityClaimForReview');

const TWO_DOORS =
    '\n\n**Two doors, one queue.** `/api/admin/farm-claims` is gated by a shared '
    + '`PLATFORM_ADMIN_API_KEY` and sits in `PUBLIC_PATH_PREFIXES`, because the Edge calls '
    + '`getToken()` and understands only a session cookie. A browser page cannot use it: it '
    + 'holds no key, and shipping one would inline a platform credential into every user’s '
    + 'bundle. THIS route is session-gated — `admin.manage` AND the platform-support tenant, '
    + 'so it 404s everywhere else — and is what the review page calls. The keyed routes stay '
    + 'for scripts.';

const NO_EIK =
    '\n\n**No endpoint here returns an ЕИК, because none is held.** '
    + '`FarmIdentityClaim` stores `eikHash` — a blind index — and the reviewer looks the farm '
    + 'up in the commercial register and types what they find. That is what makes the check '
    + 'independent: a queue that displayed the claimed number would turn verification into a '
    + 'transcription exercise. There is no approve-without-typing path by construction.';

export function registerFarmClaimsAdminPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/farm-claims',
        operationId: 'listFarmClaimsForReview',
        summary: 'The farm-identity review queue',
        description:
            'Oldest first, so a backlog drains instead of starving. `status` defaults to '
            + '`PENDING` — the queue is work outstanding, and the other two statuses are '
            + 'reachable by filter so a resolved claim can be looked up, not so the default '
            + 'view buries the backlog in them.\n\nAn unrecognised `status` is a 400 rather '
            + 'than being ignored: answering with the default queue under a filter the caller '
            + 'asked for and did not get would make a reviewer looking for DISPUTED claims '
            + 'read a list of PENDING ones as "there are none".'
            + TWO_DOORS + NO_EIK,
        tags: ['Admin'],
        params: TenantParams,
        query: z.object({
            status: z.string().optional().openapi({
                description: 'PENDING (default), VERIFIED or DISPUTED. One value.',
            }),
            limit: z.string().optional().openapi({
                description: 'Positive integer, clamped to 100.',
            }),
            before: z.string().optional().openapi({
                description: '`createdAt` cursor; returns claims strictly older than this.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_LIMIT, INVALID_CURSOR, or a bad `status` filter value.',
            404: 'Not the platform-support tenant — `assertPlatformSupport` 404s rather than '
                + 'forbidding, so another tenant is not told this console exists.',
        }),
        success: {
            status: 200,
            description: 'One page of the queue.',
            schema: z.object({ claims: z.array(ClaimRow) }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/farm-claims/{claimId}/verify',
        operationId: 'verifyFarmClaimFromConsole',
        summary: 'Verify a claim against an ЕИК the reviewer supplies',
        description:
            'The body carries the ЕИК the reviewer found in the register; the server checks '
            + 'it against the stored hash and rehashes under the current `LOOKUP_HMAC_KEY` on '
            + 'success, so a row hashed under a previous key still matches during a rotation '
            + 'window.\n\n**`reviewedBy` is NOT a field.** The keyed sibling takes it from the '
            + 'body, so whoever holds the key can type any name into the audit trail; this '
            + 'route takes it from the SESSION, which is the one place in the review path that '
            + 'names a person the Edge authenticated rather than a string the caller chose.'
            + '\n\nSeven outcomes, each with its own status, and the map is shared with the '
            + 'keyed route rather than re-derived: two doors answering different statuses for '
            + 'the same outcome is how a client comes to believe two things about one claim. '
            + '`ALREADY_VERIFIED` is a 200 because the usecase is idempotent, and '
            + '`EIK_MISMATCH` (422) must be distinguishable from `DISPUTED_COLLISION` (409) — '
            + 'the first is a retryable typo, the second means two farms claim one ЕИК and '
            + 'needs a decision between them.'
            + TWO_DOORS + NO_EIK,
        tags: ['Admin'],
        params: ClaimParams,
        body: z.object({
            eik: z.string().min(1).max(32).openapi({
                description:
                    'A STRING, never a number: an ЕИК may be 9 or 13 digits, a 13-digit value '
                    + 'exceeds the safe integer range for exact arithmetic, and a leading zero '
                    + 'would be eaten by a numeric round-trip.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON, INVALID_BODY, or `EIK_INVALID` — the checksum fails, so it was '
                + 'refused before any lookup and nothing was touched.',
            404: 'The claim does not exist, or this is not the platform-support tenant.',
            409: '`DISPUTED_COLLISION` — another farm already holds a VERIFIED claim on this '
                + 'ЕИК, and THIS claim is now DISPUTED — or `ALREADY_DISPUTED`.',
            422: '`EIK_MISMATCH` — the number does not match what this farm claimed. Nothing '
                + 'was changed.',
        }),
        success: {
            status: 200,
            description: '`VERIFIED`, or `ALREADY_VERIFIED` on a double submit.',
            schema: z.object({
                result: z.enum(['VERIFIED', 'ALREADY_VERIFIED']),
            }),
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/farm-claims/{claimId}/dispute',
        operationId: 'disputeFarmClaimFromConsole',
        summary: 'Record a reviewer\'s verdict that a claim is wrong',
        description:
            'The refusal path, and it deliberately does NOT require an ЕИК: a reviewer who '
            + 'has established that a claim is wrong may not have a correct number to supply, '
            + 'and demanding one would make refusing harder than approving. A console that '
            + 'offered only `verify` would do exactly that, which nudges a reviewer toward '
            + 'approval — the opposite of what identity verification wants.\n\n'
            + '**Distinct from `DISPUTED_COLLISION`.** That outcome comes out of `verify` when '
            + 'two farms claim one ЕИК and the SYSTEM notices. This is a judgement about one '
            + 'claim, reached from evidence the system does not hold. Both end with '
            + '`status = DISPUTED`, which is why `reason` is REQUIRED — without it the row '
            + 'cannot say which of the two happened, and the next reviewer inherits a verdict '
            + 'with no grounds.\n\n'
            + '`reason` is kept for the audit trail and is **not shown to the claiming farm**. '
            + 'A rejection NOTICE is a separate question from a rejection RECORD.\n\n'
            + 'A VERIFIED claim is not disputable here (409): unwinding one has to unwind '
            + '`FarmProfile.eik` and whatever has been filed from it, which is a deliberate '
            + 'operator action rather than a queue button.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: ClaimParams,
        body: z.object({
            reason: z.string().min(1).max(500).openapi({
                description: 'Why the claim is wrong. Audit trail only; the farm is not shown it.',
            }),
        }),
        extraResponses: codedErrorResponses({
            400: 'INVALID_JSON or INVALID_BODY — a reason is required and may not be blank.',
            404: 'The claim does not exist, or this is not the platform-support tenant.',
            409: '`ALREADY_VERIFIED` — see above; unwinding a verified claim is not a queue action.',
        }),
        success: {
            status: 200,
            description: 'Recorded as disputed.',
            schema: z.object({ result: z.enum(['DISPUTED']) }),
        },
    });
}

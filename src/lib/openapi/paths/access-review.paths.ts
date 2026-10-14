/**
 * Access-review campaigns — the five `access-reviews` paths (#1739, #1712 batch 6).
 *
 * ## Why this module exists
 *
 * All five paths sat on `tests/guards/openapi-undocumented-baseline.json`, so
 * their refusal codes were returned, localised server-side and shown in
 * Bulgarian — and a client could not learn about any of them from the
 * contract. The owner's rule is that the phone resolves display from
 * `error.message`, so a code matters to a client only where it ACTS, and those
 * it takes from the spec. Registering the paths is therefore the fix rather
 * than shipping a parallel code list (#1718, closed in favour of this).
 *
 * ## Ten codes, not twelve, and the two that stay are a finding
 *
 * #1739 expected all twelve `ACCESS_REVIEW_*` codes to leave the baseline.
 * Traced rather than assumed, each code to the usecase that raises it and each
 * usecase to the route that calls it:
 *
 *   - `ACCESS_REVIEW_DECISION_ALREADY_EXECUTED` and
 *     `ACCESS_REVIEW_DECISION_NOT_RECORDED` are raised **only** by
 *     `revokeDecision`, and `revokeDecision` has NO route. The decisions path
 *     exports `PUT` alone and calls `submitDecision`; there is no `DELETE`.
 *
 * So no operation can return those two, and documenting them here would be
 * the batch-8 mistake one level worse — telling a caller about a refusal it
 * cannot receive, when there is no operation to attach it to. They stay on
 * `UNDOCUMENTED_BASELINE` with a written reason, and the unmounted usecase is
 * filed as #1793.
 *
 * ## Schemas are IMPORTED, not redeclared
 *
 * `CreateAccessReviewSchema` and `SubmitDecisionSchema` come from
 * `@/app-layer/schemas/access-review.schemas`. A route and a spec module each
 * declaring their own Zod for one body are two schemas nothing compares, so a
 * change to either is invisible to the other —
 * `tests/guards/request-body-declared-once.test.ts` caps that at zero.
 *
 * ## Every method, because partial registration fails
 *
 * `openapi-paths-complete.test.ts` requires a registered path to document
 * every method its file exports, with no grandfathering. The five files export
 * GET+POST, GET, POST, PUT and GET respectively — six operations, all below.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import {
    CreateAccessReviewSchema,
    SubmitDecisionSchema,
} from '@/app-layer/schemas/access-review.schemas';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose campaigns these are.' }),
});

const ReviewParams = TenantParams.extend({
    reviewId: z.string().openapi({ description: 'The campaign.' }),
});

const DecisionParams = ReviewParams.extend({
    decisionId: z.string().openapi({
        description:
            'The per-subject decision row. Addressed directly rather than by subject user: a campaign snapshots its roster at creation, so the decision is the stable handle and the subject’s current membership may since have changed.',
    }),
});

const ListRowSchema = z
    .object({
        id: z.string(),
        tenantId: z.string(),
        name: z.string(),
        scope: z.string().openapi({
            description: 'What the campaign covers. A string rather than an enum in the RESPONSE so a campaign created before a scope was renamed stays readable — the accepted request values are a closed set.',
        }),
        status: z.enum(['OPEN', 'IN_REVIEW', 'CLOSED']).openapi({
            description:
                '`OPEN` until the first decision is submitted, which transitions it to `IN_REVIEW`; `CLOSED` once closed. A client cannot set this — the first `PUT` of a decision moves it, and `POST /close` ends it.',
        }),
        periodStartAt: z.string().datetime({ offset: true }),
        periodEndAt: z.string().datetime({ offset: true }),
        dueAt: z.string().datetime({ offset: true }).nullable(),
        closedAt: z.string().datetime({ offset: true }).nullable().openapi({
            description: '`null` until the campaign is closed. Set together with `status: CLOSED`; the two always agree.',
        }),
        createdAt: z.string().datetime({ offset: true }),
        reviewerUserId: z.string().nullable().openapi({
            description:
                'Who must decide. `null` means unassigned — and that is not cosmetic: `ACCESS_REVIEW_NOT_ASSIGNED_REVIEWER` refuses a decision from anyone who is not this person.',
        }),
        createdByUserId: z.string().nullable(),
        _count: z.object({ decisions: z.number().int() }).openapi({
            description: 'How many subjects the campaign snapshotted. Returned so a list can show progress without fetching each campaign’s decision graph.',
        }),
    })
    .openapi('AccessReviewListRow');

const ListSchema = z
    .object({
        rows: z.array(ListRowSchema),
        truncated: z.boolean().openapi({
            description:
                'True when the list hit the shared backfill cap and is a PREFIX rather than the whole set. Newest first, so a truncated page is the most recent campaigns — a client showing a total must not derive it from `rows.length` when this is true.',
        }),
    })
    .openapi('AccessReviewList');

const CreatedSchema = z
    .object({
        accessReviewId: z.string(),
        snapshotCount: z.number().int().openapi({
            description:
                'How many subjects were captured. The roster is frozen at creation, so this is the denominator every later count is against — a member who joins or leaves afterwards does not change it.',
        }),
    })
    .openapi('AccessReviewCreated');

const DetailSchema = z
    .object({
        id: z.string(),
        status: z.enum(['OPEN', 'IN_REVIEW', 'CLOSED']),
        name: z.string(),
        decisions: z.array(z.record(z.string(), z.unknown())).openapi({
            description:
                'The decision graph the reviewer page renders: one row per snapshotted subject, with its snapshot role and the verdict if one has been submitted. Loosely typed here on purpose — it is a page-shaped projection joining the roster, the snapshot and the decision, and pinning every field would duplicate a shape that exists to serve one screen.',
        }),
        lastActivityByUser: z.record(z.string(), z.string().datetime({ offset: true }).nullable()).openapi({
            description:
                'Subject user id → most recent session activity, or `null` where there is none. Returned with the campaign because it is what a reviewer judges on, and `null` is the answer that matters most: a subject with no activity in the period is the one a revoke is for.',
        }),
    })
    .openapi('AccessReviewDetail', {
        description:
            'One campaign with the activity a reviewer needs. Shaped for the reviewer page rather than as a normalised record.',
    });

const ClosedSchema = z
    .object({
        accessReviewId: z.string(),
        executions: z.array(z.record(z.string(), z.unknown())).openapi({
            description: 'What each decision did when the campaign closed — a REVOKE is applied here, not when it is submitted.',
        }),
        evidenceFileRecordId: z.string().nullable().openapi({
            description:
                '`null` when the PDF could not be generated or stored. The campaign still closes: the artifact is evidence OF the close rather than a precondition for it, and an operator-triggered regenerate is the follow-up. A client must not read `null` as "the close failed".',
        }),
        counts: z
            .object({
                total: z.number().int(),
                executed: z.number().int(),
                confirmed: z.number().int(),
                skipped: z.number().int(),
            })
            .openapi({
                description: 'Derived from `executions`, for callers that do not want to walk the array. `executed + confirmed + skipped` accounts for `total`.',
            }),
    })
    .openapi('AccessReviewClosed');

const DecisionSubmittedSchema = z
    .object({
        decisionId: z.string(),
        accessReviewId: z.string(),
        decision: z.enum(['CONFIRM', 'REVOKE', 'MODIFY']),
        transitionedToInReview: z.boolean().openapi({
            description:
                'True only when this submission was the FIRST on the campaign and moved it `OPEN` → `IN_REVIEW`. A client can use it to refresh a status badge without re-reading the campaign.',
        }),
    })
    .openapi('AccessReviewDecisionSubmitted');

export function registerAccessReviewPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/access-reviews',
        operationId: 'listAccessReviews',
        summary: 'List access-review campaigns',
        description:
            'Newest first, capped by the shared list backfill cap — see `truncated`.\n\n'
            + 'Behind the `CERTIFICATION` module, so a farm without it gets `MODULE_DISABLED` with a `reason` saying whether an administrator of that farm can turn it on or whether the plan excludes it. That distinction matters here: telling somebody to ask an admin who cannot help is its own defect.',
        tags: ['Access reviews'],
        params: TenantParams,
        success: { status: 200, description: 'The campaigns, newest first.', schema: ListSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/access-reviews',
        operationId: 'createAccessReview',
        summary: 'Open an access-review campaign',
        description:
            'Snapshots the roster at creation, which is what makes the campaign auditable: later membership changes do not alter what was reviewed.\n\n'
            + '**Refusal codes.**\n'
            + '- `ACCESS_REVIEW_NO_ELIGIBLE_SUBJECTS` — the scope matched nobody, so there is nothing to review. Not a validation error about the request: the body is well-formed and the farm simply has no members the scope covers. Widening the scope or adding members is the remedy; retrying is not.\n'
            + '- `ACCESS_REVIEW_INELIGIBLE_SUBJECTS` — one or more named subjects cannot be reviewed. Distinct from the above on purpose: here the caller asked for specific people and at least one of them is not reviewable, so the fix is to the request rather than to the farm.\n'
            + '- `MODULE_DISABLED` — as on the list.',
        tags: ['Access reviews'],
        params: TenantParams,
        body: CreateAccessReviewSchema,
        success: { status: 201, description: 'The campaign was opened and its roster snapshotted.', schema: CreatedSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/access-reviews/{reviewId}',
        operationId: 'getAccessReview',
        summary: 'Read one campaign and its decision graph',
        description:
            'Returns the roster, each subject’s snapshot role, any verdict already submitted, and each subject’s last session activity — which is the evidence a reviewer actually decides on.\n\n'
            + '**Refusal codes.**\n'
            + '- `ACCESS_REVIEW_NOT_FOUND` — no such campaign in this farm. Also the answer for a campaign that exists in ANOTHER farm, deliberately: a distinguishable response would make campaign ids enumerable across tenants.',
        tags: ['Access reviews'],
        params: ReviewParams,
        success: { status: 200, description: 'The campaign, shaped for the reviewer page.', schema: DetailSchema },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/access-reviews/{reviewId}/decisions/{decisionId}',
        operationId: 'submitAccessReviewDecision',
        summary: 'Submit a reviewer verdict for one subject',
        description:
            'A discriminated union on `decision`: `CONFIRM`, `REVOKE`, or `MODIFY` with a target role. The first submission on a campaign moves it `OPEN` → `IN_REVIEW` — see `transitionedToInReview`.\n\n'
            + '**A REVOKE is recorded here and APPLIED at close.** Submitting one does not remove anybody; `POST /close` executes them. So a client must not report access as withdrawn on a 200 from this operation.\n\n'
            + '**Refusal codes.**\n'
            + '- `ACCESS_REVIEW_NOT_FOUND` — no such campaign in this farm.\n'
            + '- `ACCESS_REVIEW_DECISION_NOT_FOUND` — the campaign exists but holds no such decision row. Usually a stale client: the roster is snapshotted, so a decision id from a different campaign will not resolve here.\n'
            + '- `ACCESS_REVIEW_NOT_ASSIGNED_REVIEWER` — the caller is not the campaign’s assigned reviewer. A permission shortfall that no role lifts, because the constraint is identity rather than tier: an OWNER who is not the reviewer is refused too, which is the point of assigning one.\n'
            + '- `ACCESS_REVIEW_DECISION_ALREADY_RECORDED` — a verdict is already on this row. Decisions are recorded once; the way to change one is `revokeDecision`, which has no route today (#1793).\n'
            + '- `ACCESS_REVIEW_DECISIONS_IMMUTABLE` — the campaign is closed, so its decisions are frozen. Retrying cannot work and no role lifts it.',
        tags: ['Access reviews'],
        params: DecisionParams,
        body: SubmitDecisionSchema,
        success: { status: 200, description: 'The verdict was recorded.', schema: DecisionSubmittedSchema },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/access-reviews/{reviewId}/close',
        operationId: 'closeAccessReview',
        summary: 'Close a campaign and execute its revocations',
        description:
            'The only operation that CHANGES anyone’s access. Every `REVOKE` recorded during the campaign is applied here, a PDF artifact is generated as evidence of the close, and the campaign becomes `CLOSED` and immutable.\n\n'
            + '`evidenceFileRecordId` may be `null` — the artifact is evidence OF the close rather than a precondition for it, so a storage failure does not block closing.\n\n'
            + '**Refusal codes.**\n'
            + '- `ACCESS_REVIEW_NOT_FOUND` — no such campaign in this farm.\n'
            + '- `ACCESS_REVIEW_ALREADY_CLOSED` — it is closed. Idempotent in effect but reported rather than silently accepted, because a second close would generate a second evidence artifact for one event.\n'
            + '- `ACCESS_REVIEW_DECISIONS_PENDING` — subjects remain undecided. A campaign closed with gaps would be an audit record asserting a review that did not happen, so the refusal is the control: decide the rest, then close.\n'
            + '- `ACCESS_REVIEW_WOULD_ORPHAN_OWNERS` — executing the revocations would leave the farm with no OWNER. Refused regardless of role, including for an OWNER revoking themselves: a farm nobody can administer cannot be recovered through the product.',
        tags: ['Access reviews'],
        params: ReviewParams,
        success: { status: 200, description: 'Closed, with what each decision did.', schema: ClosedSchema },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/access-reviews/{reviewId}/evidence',
        operationId: 'downloadAccessReviewEvidence',
        summary: 'Download the campaign’s evidence PDF',
        description:
            'Streams the artifact generated at close. `Content-Disposition` carries the stored filename, which may be Cyrillic.\n\n'
            + '**Refusal codes.** These are the shared evidence-file codes rather than campaign ones, because the refusals are about the FILE:\n'
            + '- `EVIDENCE_FILE_NOT_FOUND` — the campaign names an artifact that no longer resolves.\n'
            + '- `EVIDENCE_FILE_DELETED` — the artifact was soft-deleted. Distinguished from the above so a client can say "it was removed" rather than "it never existed".\n'
            + '- `EVIDENCE_FILE_NOT_DOWNLOADABLE` — the record exists but is not in a downloadable state.\n\n'
            + 'A 403 is also possible from the antivirus gate when the stored file’s scan status disallows download.\n\n'
            + 'Two 404s on this path are still UNCODED — a missing campaign, and a campaign that has never generated an artifact. They are #1712 work rather than this registration’s, and a client should treat an uncoded 404 here as "no artifact available".',
        tags: ['Access reviews'],
        params: ReviewParams,
        success: {
            status: 200,
            description: 'The PDF stream.',
            content: { 'application/pdf': z.string().openapi({ format: 'binary' }) },
        },
    });
}

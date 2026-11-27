/**
 * Evidence retention — expiry, the sweep, and the two-step destruction of
 * stored bytes (#3080).
 *
 * Seven paths, its own module rather than part of `evidence.paths.ts`,
 * because this family answers a different question. The register is "what do
 * we hold"; this is "for how long, and what happens when that runs out" —
 * and the endpoints that ACT on the answer are destructive in a way nothing
 * in the register is.
 *
 * Three things are contract.
 *
 * ── "Expired" meant two different things, and now means one ──
 *
 * `GET /retention/expired` lists every record with an `expiredAt`, and
 * `retention/metrics.expiredCount` used to count only those that were ALSO
 * not archived. Since the sweep sets `expiredAt` and `isArchived` together,
 * its own action moved a record out of the count at the moment it entered
 * the list — so the count tended to zero while the list grew for ever, and a
 * dashboard read "Expired: 0" beside a list of everything.
 *
 * FIXED in #3281 (owner ruling 2026-11-27): the count means "records whose
 * retention has lapsed" and agrees with the list. `archivedCount` is still
 * the complement of neither, which is deliberate — it counts archived
 * records with no condition on expiry, so it includes manual archives.
 *
 * ── Purge releases the BYTES before the row, and the order is the point ──
 *
 * `purgeEntity` has an `Evidence`-specific branch that deletes the stored
 * object first. Deleting the row first loses the only pointer to the file,
 * leaving it readable in storage while the product reports it purged — a
 * deletion that did not happen, reported as one that did.
 *
 * ── `DAYS_AFTER_UPLOAD` overwrites what you sent ──
 *
 * Under that policy the server DERIVES `retentionUntil` from
 * `createdAt + retentionDays` and discards any `retentionUntil` in the same
 * request. Silently, and the derived value wins.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { EvidenceRetentionSchema, EvidenceRetentionSweepSchema } from '@/lib/schemas';
import { codedErrorResponses, op } from './helpers';

const TAGS = ['Evidence'];

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose register this is.' }),
});

const EvidenceParams = TenantParams.extend({
    id: z.string().openapi({ description: 'The evidence record id.' }),
});

const EVIDENCE_404 =
    '`EVIDENCE_NOT_FOUND` — no such record on this farm. An id belonging to a '
    + 'DIFFERENT tenant answers identically.';

/**
 * The retention columns, as every operation here returns them.
 *
 * A projection of the stored record rather than a new shape: the full row is
 * `Evidence` in `evidence.paths.ts`, and these are the fields this family
 * reads and writes.
 */
const RetentionViewSchema = z
    .object({
        id: z.string(),
        title: z.string(),
        type: z.enum(['FILE', 'LINK', 'TEXT']),
        isArchived: z.boolean().openapi({
            description:
                'Set by the SWEEP as well as by the manual archive control, which is why a '
                + 'record can be archived without anybody having archived it.',
        }),
        retentionPolicy: z.enum(['NONE', 'FIXED_DATE', 'DAYS_AFTER_UPLOAD']).nullable(),
        retentionDays: z.number().int().nullable(),
        retentionUntil: z.string().datetime().nullable().openapi({
            description:
                'When retention lapses. Under `DAYS_AFTER_UPLOAD` this is DERIVED by the '
                + 'server and not what a caller sent.',
        }),
        expiredAt: z.string().datetime().nullable().openapi({
            description:
                'Stamped by the sweep when it first processes a lapsed record, and '
                + 'idempotent — a second sweep leaves an existing value alone, so this is '
                + 'when it was FIRST noticed rather than when retention lapsed. Those differ '
                + 'by however long the sweep took to run.',
        }),
        createdAt: z.string().datetime().openapi({
            description:
                'The base `DAYS_AFTER_UPLOAD` counts from — upload time, not the time the '
                + 'policy was set, so applying a 30-day policy to a year-old record expires '
                + 'it immediately.',
        }),
        updatedAt: z.string().datetime(),
    })
    .openapi('EvidenceRetentionView');

const RetentionMetricsSchema = z
    .object({
        expiringCount: z.number().int().openapi({
            description:
                'Records whose `retentionUntil` falls in the next 30 days — a FIXED window, '
                + 'not the `?days=` one the expiring LIST takes, so the card and that list '
                + 'answer different questions whenever a caller passes `days`.',
        }),
        archivedCount: z.number().int().openapi({
            description:
                'Archived records, with NO condition on expiry — so it counts manual '
                + 'archives alongside swept ones and is the complement of neither sibling.',
        }),
        expiredCount: z.number().int().openapi({
            description:
                'Records whose retention has LAPSED — archived or not. Agrees with '
                + '`GET /retention/expired`, so the card and that list describe the same '
                + 'set, and the number only grows.\n\n'
                + 'It excluded archived records until #3281, which made it a sweep-backlog '
                + 'gauge rather than a count of expired records: the sweep writes '
                + '`expiredAt` and `isArchived` in one update, so every record it processed '
                + 'left this count at the moment it joined that list, and a farm with an '
                + 'up-to-date sweep read "Expired: 0" beside a list of everything. A client '
                + 'written against the old behaviour will now see a number that grows '
                + 'rather than one that sits at zero.',
        }),
    })
    .openapi('EvidenceRetentionMetrics');

const SweepResultSchema = z
    .object({
        scanned: z.number().int().openapi({
            description: 'Lapsed, unarchived records the sweep found.',
        }),
        expired: z.number().int(),
        archived: z.number().int().openapi({
            description:
                'How many were archived — or, on a DRY RUN, how many WOULD be: the field is '
                + 'set to `scanned` without anything being written. Read `dryRun` alongside '
                + 'it or you will be told work happened that did not.',
        }),
        dryRun: z.boolean().optional().openapi({
            description: 'Present and true only on a dry run.',
        }),
    })
    .openapi('EvidenceRetentionSweepResult');

const PurgeResultSchema = z
    .object({ success: z.literal(true), purged: z.literal(true) })
    .openapi('EvidencePurgeResult');

export function registerEvidenceRetentionPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/retention',
        operationId: 'setEvidenceRetention',
        summary: 'Set or clear retention on a record',
        description:
            'Partial: every field is optional and only those present are written.\n\n'
            + '**`DAYS_AFTER_UPLOAD` overwrites `retentionUntil`.** Under that policy the '
            + 'server derives the date as `createdAt + retentionDays` and discards anything '
            + 'you sent in the same request — silently, with the derived value winning. The '
            + 'derivation also fires when the STORED policy is already `DAYS_AFTER_UPLOAD` '
            + 'and you send only `retentionDays`, which is how a cadence change re-dates an '
            + 'existing record.\n\n'
            + 'It counts from UPLOAD, not from when the policy was set, so applying a '
            + '30-day policy to a year-old record expires it immediately and the next sweep '
            + 'archives it. That is the intended meaning of the policy and the most '
            + 'surprising thing this endpoint does.\n\n'
            + 'Writes an `EVIDENCE_RETENTION_UPDATED` audit entry.',
        tags: TAGS,
        params: EvidenceParams,
        body: EvidenceRetentionSchema,
        success: {
            status: 200,
            description: 'The record with its retention fields as stored.',
            schema: RetentionViewSchema,
        },
        extraResponses: codedErrorResponses({
            400: '`retentionDays` outside 1–36500, an unknown `retentionPolicy`, or a '
                + 'malformed `retentionUntil`.',
            403: 'Read-only on this farm.',
            404: EVIDENCE_404,
        }),
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/retention/expiring',
        operationId: 'listExpiringEvidence',
        summary: 'Records whose retention lapses soon',
        description:
            'Live, unarchived records with a `retentionUntil` at or before now + `days`, '
            + 'soonest first.\n\n'
            + '**`days` is not validated**, and the three ways that shows are worth knowing '
            + 'because none of them is an error:\n\n'
            + '- A non-numeric value falls back to **30** rather than refusing, so '
              + '`?days=banana` answers confidently about a window you did not ask for.\n'
            + '- A NEGATIVE value passes through and puts the boundary in the PAST, so '
              + '`?days=-5` lists records that lapsed days ago — under an endpoint called '
              + '"expiring".\n'
            + '- There is no upper bound, so a large value returns every record carrying a '
              + 'retention date at all.\n\n'
            + 'Tracked with #3281. Send a sane positive integer.\n\n'
            + 'The read is also UNBOUNDED — no page size and no cursor — so the response '
            + 'grows with the farm.',
        tags: TAGS,
        params: TenantParams,
        query: z.object({
            days: z.coerce.number().int().optional().openapi({
                description:
                    'Look-ahead window in days. Defaults to 30, including when the value '
                    + 'sent cannot be parsed. Not range-checked — see the description.',
                example: 30,
            }),
        }),
        success: {
            status: 200,
            description: 'Records lapsing inside the window, soonest first.',
            schema: z.array(RetentionViewSchema),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/retention/expired',
        operationId: 'listExpiredEvidence',
        summary: 'Records whose retention has lapsed',
        description:
            'Every record carrying an `expiredAt`, newest first — **including archived '
            + 'ones**, since the sweep archives everything it processes. Since #3281 '
            + '`metrics.expiredCount` counts the same set, so the card and this list '
            + 'agree; the count excluded archived records before that and disagreed with '
            + 'this endpoint by construction.\n\n'
            + 'So this is the cumulative history of expiry, not a work queue. Soft-deleted '
            + 'records are excluded.\n\n'
            + 'UNBOUNDED, like its sibling: no page size, no cursor.',
        tags: TAGS,
        params: TenantParams,
        success: {
            status: 200,
            description: 'Expired records, newest first.',
            schema: z.array(RetentionViewSchema),
        },
    });

    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/evidence/retention/metrics',
        operationId: 'getEvidenceRetentionMetrics',
        summary: 'The three retention counts',
        description:
            'Three counts over three DIFFERENT populations, so read '
            + '`EvidenceRetentionMetrics` before rendering any of them — they are not a '
            + 'breakdown and do not sum to anything. `expiringCount` uses a FIXED 30-day '
            + 'window rather than the `?days=` one the expiring list takes, and '
            + '`archivedCount` has no condition on expiry at all.\n\n'
            + 'Needs only READ, unlike the register\'s `/evidence/metrics`, which is '
            + 'ADMIN. The two are unrelated payloads despite the matching path segment.\n\n'
            + 'The route\'s own docblock advertised a "top practices" breakdown until this '
            + 'change: that grouped by `Evidence.practiceId`, and both the column and '
            + '`Practice` went with the GRC teardown. The usecase had recorded the removal; '
            + 'the route had not.',
        tags: TAGS,
        params: TenantParams,
        success: {
            status: 200,
            description: 'The three counts.',
            schema: RetentionMetricsSchema,
        },
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/retention/sweep',
        operationId: 'runEvidenceRetentionSweep',
        summary: 'Run the retention sweep for this farm',
        description:
            'ADMIN. Finds live, unarchived records whose `retentionUntil` has passed, '
            + 'stamps `expiredAt` and sets `isArchived`.\n\n'
            + '**Archiving is not deleting.** The sweep destroys nothing: the records stay '
            + 'readable and their files stay in storage. Destruction is the separate, '
            + 'two-step `delete` → `purge` path.\n\n'
            + '`expiredAt` is only stamped when not already set, so the sweep is idempotent '
            + 'and the column records when a lapse was FIRST noticed rather than when it '
            + 'happened.\n\n'
            + 'Send `{"dryRun": true}` to see what it would do. Note the response then '
            + 'reports `archived` equal to `scanned` while writing nothing — the field '
            + 'means "would archive", so read `dryRun` with it.\n\n'
            + 'There is also a SCHEDULED sweep, so a farm\'s records get archived whether '
            + 'or not anybody calls this. This endpoint is for running it now.',
        tags: TAGS,
        params: TenantParams,
        body: EvidenceRetentionSweepSchema,
        success: {
            status: 200,
            description: 'What was archived — or would have been, on a dry run.',
            schema: SweepResultSchema,
        },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/restore',
        operationId: 'restoreEvidence',
        summary: 'Restore a soft-deleted record',
        description:
            'Clears `deletedAt`. ADMIN. The body is the restored record.\n\n'
            + 'Restoring a record that is **not deleted** answers **404**, not 409 — and '
            + 'these 404s are UNCODED: a `message` and no `error.code`, unlike the '
            + '`EVIDENCE_NOT_FOUND` every read returns. Switch on the status, and do not '
            + 'expect to tell "no such record" from "not deleted" programmatically.\n\n'
            + 'This is the DELETE lifecycle, not the retention one. An ARCHIVED record is '
            + 'not deleted and is returned by `unarchive` instead; the two pairs are '
            + 'independent and a record can be both.',
        tags: TAGS,
        params: EvidenceParams,
        success: {
            status: 200,
            description: 'The restored record.',
            schema: RetentionViewSchema,
        },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: 'No such record on this farm, OR it is not deleted. Uncoded, and the two '
                + 'are not distinguishable from the response.',
        }),
    });

    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/evidence/{id}/purge',
        operationId: 'purgeEvidence',
        summary: 'Permanently destroy a soft-deleted record and its file',
        description:
            'HARD delete, ADMIN, and the only operation in this API that destroys stored '
            + 'BYTES. There is no undo.\n\n'
            + 'The record MUST already be soft-deleted: purging a live one answers **404**, '
            + 'uncoded. That two-step is the whole safety mechanism, so a client should not '
            + 'chain this onto a delete.\n\n'
            + '**The bytes are released BEFORE the row, and the order is load-bearing.** '
            + '`purgeEntity` carries an `Evidence`-specific branch that calls '
            + '`purgeEvidenceBytes` first, because the row holds the only pointer to the '
            + 'stored object: deleting it first leaves the file readable in storage while '
            + 'the product reports the evidence purged — a deletion that did not happen, '
            + 'reported as one that did. Nothing in the response distinguishes the two, '
            + 'which is why the ordering is in the code rather than in a caller\'s hands.\n\n'
            + 'The audit trail SURVIVES: the hash-chained entries describing this '
            + 'record\'s life, including `ENTITY_PURGED`, outlive it. So the activity '
            + 'history remains while `GET /evidence/{id}` answers 404.',
        tags: TAGS,
        params: EvidenceParams,
        success: { status: 200, description: 'Purged.', schema: PurgeResultSchema },
        extraResponses: codedErrorResponses({
            403: 'Not an administrator of this farm.',
            404: 'No such record on this farm, OR it has not been soft-deleted first. '
                + 'Uncoded.',
        }),
    });
}

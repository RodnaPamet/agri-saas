/**
 * «Функции» — the session-authenticated flag console (#2706).
 *
 * Documented because `openapi-paths-complete`'s baseline only SHRINKS, and
 * because the thing a reader most needs to know is not visible from the
 * shapes: there are TWO doors onto this table and only one of them a browser
 * can use.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { UpsertFlagBody } from '@/app-layer/schemas/feature-flag-admin.schemas';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' } }),
});

const FlagRow = z
    .object({
        key: z.string(),
        enabled: z.boolean(),
        cohorts: z.array(z.string()).openapi({
            description:
                'EMPTY means "everyone, once enabled"; non-empty NARROWS. Read as OR, an enabled '
                + 'flag with cohorts set would expose the surface to the whole deployment.',
        }),
        description: z.string().nullable(),
        updatedAt: z.string().datetime({ offset: true }),
    })
    .openapi('FeatureFlagRow');

const FlagConsolePayload = z
    .object({
        flags: z.array(FlagRow).openapi({
            description:
                'The RAW table, never a resolved per-caller view. An operator opens this screen '
                + 'precisely to see that a flag is enabled-but-cohort-gated, which `/api/auth/me` '
                + 'collapses to one boolean on purpose.',
        }),
        cohorts: z
            .array(z.object({ cohort: z.string(), members: z.number().int() }))
            .openapi({
                description:
                    'Cohort SIZES. A flag naming a cohort with zero members is OFF for everyone '
                    + 'while reading as a live rollout, which the flag row alone cannot show. A '
                    + 'cohort with no members does not appear at all — there is no row to group.',
            }),
        forcedOff: z.boolean().openapi({
            description:
                '`FEATURE_FLAGS_FORCE_OFF` is set, which overrides EVERY row. A client showing a '
                + 'flag as enabled while this is true is actively misleading. It is deliberately '
                + 'not clearable through any API — the switch exists for when the application is '
                + 'the thing going wrong — so clearing it is an operator action on the host.',
        }),
    })
    .openapi('FeatureFlagConsolePayload');

const TWO_DOORS =
    '\n\n**Two doors, one table.** `/api/admin/feature-flags` is gated by a shared '
    + '`PLATFORM_ADMIN_API_KEY` and sits in `PUBLIC_PATH_PREFIXES`, because the Edge calls '
    + '`getToken()` and understands only a session cookie. A browser page cannot use it: it '
    + 'holds no key, and shipping one would inline a platform credential into every user’s '
    + 'bundle. THIS route is session-gated — `admin.manage` AND the platform-support tenant, '
    + 'so it 404s everywhere else — and is what the «Функции» page calls. The keyed routes '
    + 'stay for scripts and for an incident where the session path is the broken thing.';

export function registerFeatureFlagsAdminPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/feature-flags',
        operationId: 'listFeatureFlagsForConsole',
        summary: 'The platform flag table, its cohort sizes and the kill switch',
        description:
            'Everything «Функции» needs in ONE request, where the keyed console splits the '
            + 'cohort sizes onto `/cohorts`. The page needs all three to render a true answer '
            + 'and a partial render here is a wrong one — see the `forcedOff` and `cohorts` '
            + 'field descriptions.\n\nA flip propagates in ≤30s: the table is Redis-cached '
            + 'under one key and the write path invalidates it.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        success: { status: 200, description: 'The raw table, cohort sizes and the kill-switch state.', schema: FlagConsolePayload },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/feature-flags',
        operationId: 'upsertFeatureFlagFromConsole',
        summary: 'Create or update one flag',
        description:
            'Upsert by `key`. `cohorts` is always written explicitly: omitting it means '
            + '"everyone", never "keep whatever narrowing was there" — `undefined` in an update '
            + 'would leave the old list in place while the operator believes they just opened '
            + 'the flag to everyone.\n\nThe actor is taken from the SESSION and recorded on '
            + '`updatedByUserId`, which the keyed door cannot do: its credential is a key, so it '
            + 'records `actorType: PLATFORM_ADMIN` and no user. The request body has no actor '
            + 'field at all — a caller-supplied name in an attribution field is worse than an '
            + 'absent one.'
            + TWO_DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: UpsertFlagBody,
        success: {
            status: 200,
            description: 'The stored row and the kill-switch state.',
            schema: z.object({ flag: FlagRow, forcedOff: z.boolean() }).openapi('FeatureFlagUpsertResult'),
        },
    });
}

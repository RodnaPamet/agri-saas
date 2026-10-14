/**
 * `/api/t/{tenantSlug}/farm-brand/publication` — making a farm public, and
 * taking it back (P6.1, #1810).
 *
 * Its own module rather than appended to `farm-profile.paths.ts`. That file
 * documents `FarmProfile`, the PRIVATE farm identity holding ЕГН, ЕИК and the
 * address — the one model whose fields must never reach a public page. Putting
 * the publish operation inside it would file the public surface under the
 * private one, and the two being easy to confuse is precisely the risk this
 * phase is managing.
 *
 * The body schema is IMPORTED from `@/app-layer/schemas/farm-brand.schemas`,
 * not redeclared: `tests/guards/request-body-declared-once.test.ts` caps a
 * second declaration at zero, because a route and a spec each with their own
 * Zod for one body are two schemas nothing compares.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { SetFarmBrandPublicationSchema } from '@/app-layer/schemas/farm-brand.schemas';
import { op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ description: 'The farm whose public profile this is.' }),
});

const ProjectionResultSchema = z
    .object({
        handle: z.string().nullable().openapi({
            description:
                'The public address the farm is now served at, as `/f/{handle}` — or `null` when it is not published. A client can use the null to decide whether to show a "view your page" link without re-reading anything.',
        }),
        withdrawn: z.boolean().openapi({
            description:
                'True only when THIS call removed a previously public profile. False on a repeat withdrawal, because there was nothing left to remove — so it reports what happened rather than what the state is.',
        }),
        removedHandle: z.string().nullable().openapi({
            description:
                'The address that stopped answering, when a withdrawal or a RENAME removed one. A rename returns both: `handle` is the new address and this is the old one, which matters because the old one may be printed on paper (P6.7).',
        }),
    })
    .openapi('FarmBrandProjectionResult');

export function registerFarmBrandPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/farm-brand/publication',
        operationId: 'setFarmBrandPublication',
        summary: 'Publish the farm’s public profile, or withdraw it',
        description:
            '`PUT` because the body IS the desired state: sending the same value twice leaves the same result, which is what makes it safe to retry on a flaky connection. `published` has no default — a client that omits it is refused rather than publishing a farm by accident, because publication is the direction that is hard to take back.\n\n'
            + 'Withdrawing DELETES the public row rather than flagging it, so `/f/{handle}` stops answering outright. A rename is handled in the same call: the profile appears at the new address and the old row is removed, which is why `removedHandle` comes back alongside `handle`.\n\n'
            + '**This operation does not make a farm findable by search engines.** The projection carries an `indexable` flag which is always `false` today and is deliberately left alone by a refresh, so a republish cannot change it. The control belongs to the editor (P6.6, #1815), because "publish my page" and "let search engines index it" are different decisions.\n\n'
            + '**Refusal codes.**\n'
            + '- `FARM_BRAND_NOT_FOUND` (404) — this farm has no brand record to publish. A farm that has never opened the editor is in this state, so a client should offer to create one rather than reporting an error.\n'
            + '- `FARM_BRAND_HANDLE_REQUIRED` — no public address has been chosen. `/f/{handle}` has no other key, so there is nowhere to serve the page from.\n'
            + '- `FARM_BRAND_DISPLAY_NAME_REQUIRED` — no public name. Structural rather than editorial: the projection’s `displayName` is NOT NULL, so a farm without one cannot be represented at all.\n'
            + '- `FARM_BRAND_CONSENT_REQUIRED` — no consent has been recorded. Publishing identifiable information about a real farm without a record that somebody agreed is refused, and the consent sheet that records it is P6.6’s.\n\n'
            + 'All three publication refusals are fail-closed and apply only to `published: true`. A withdrawal never fails on them — a farm must always be able to take its page down, including one whose brand record has since become incomplete.',
        tags: ['Farm profile'],
        params: TenantParams,
        body: SetFarmBrandPublicationSchema,
        success: {
            status: 200,
            description: 'The resulting projection state.',
            schema: ProjectionResultSchema,
        },
    });
}

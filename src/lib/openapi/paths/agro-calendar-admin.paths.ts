/**
 * The agro calendar's override console, session door (#3095 stage 2). The
 * keyed sibling under `/api/admin/agro-calendar/overrides` is for scripts and
 * sits on the undocumented baseline, like farm-claims'.
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { z } from '@/lib/openapi/zod';

import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({
    tenantSlug: z.string().openapi({ param: { name: 'tenantSlug', in: 'path' } }),
});

const WindowParams = TenantParams.extend({
    windowId: z.string().openapi({ param: { name: 'windowId', in: 'path' } }),
});

const Localised = z.object({ bg: z.string(), en: z.string().optional() });

const Window = z
    .object({
        id: z.string().openapi({ description: 'The window addressed: a cited window\'s id corrects it; a new id adds one.' }),
        kind: z.enum(['sowing', 'fieldwork', 'harvest']),
        band: z.enum(['early', 'optimal', 'late']).optional().openapi({ description: 'REQUIRED for `sowing`.' }),
        region: z.enum(['north', 'south', 'both']),
        from: z.string().openapi({ example: '03-01', description: '`MM-DD`.' }),
        to: z.string().openapi({ example: '03-31', description: '`MM-DD`. Earlier than `from` means the window runs across the New Year.' }),
        title: Localised.optional(),
        note: Localised.optional(),
    })
    .passthrough()
    .openapi('AgroCalendarOverrideWindow', {
        description: 'A calendar window WITHOUT a citation — an override never carries one; `basis` replaces it.',
    });

const Override = z
    .object({
        windowId: z.string(),
        cropKey: z.string(),
        origin: z.enum(['corrected', 'added']),
        window: Window,
        basis: Localised,
        authorRef: z.string().openapi({ description: '`user:<id>` from this door; `platform-key:<generation>` from the keyed one.' }),
        setAt: z.string().datetime({ offset: true }),
    })
    .openapi('AgroCalendarOverride');

const DOORS =
    '\n\n**Platform-admin only.** The calendar is the same for every farm, so `admin.manage` alone '
    + '(which every farm\'s admin holds) is not enough: the handler adds the platform-support tenant '
    + 'check and 404s elsewhere. Scripts use the keyed `/api/admin/agro-calendar/overrides`.';

export function registerAgroCalendarAdminPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/t/{tenantSlug}/admin/agro-calendar/overrides',
        operationId: 'listAgroCalendarOverrides',
        summary: 'Live overrides of the agro calendar',
        description: 'Every live correction and addition, newest first.' + DOORS,
        tags: ['Admin'],
        params: TenantParams,
        extraResponses: codedErrorResponses({ 404: 'Not the platform-support tenant.' }),
        success: { status: 200, description: 'The live overrides.', schema: z.object({ overrides: z.array(Override) }) },
    });

    op(registry, {
        method: 'put',
        path: '/api/t/{tenantSlug}/admin/agro-calendar/overrides',
        operationId: 'setAgroCalendarOverride',
        summary: 'Correct a cited window, or add one МЗХ does not publish',
        description:
            'The origin is DERIVED from `window.id`: an id the crop\'s cited windows carry is a '
            + 'correction, an id no crop carries is an addition, and an id ANOTHER crop carries is '
            + 'refused. Replaces any live override on the same window. Takes effect at once (owner, '
            + '2026-11-16), and the window then renders «Коригирано от Agrent» with `basis` instead '
            + 'of a citation. Audited in the platform chain (`agro-calendar` scope).' + DOORS,
        tags: ['Admin'],
        params: TenantParams,
        body: z.object({
            cropKey: z.string().openapi({ example: 'potato-mid-early' }),
            window: Window,
            basis: z.object({
                bg: z.string().min(1).max(1000).openapi({ description: 'Why the window differs from the source. Required.' }),
                en: z.string().max(1000).nullable().optional(),
            }),
        }),
        extraResponses: codedErrorResponses({
            400:
                'INVALID_JSON, INVALID_BODY, AGRO_CALENDAR_UNKNOWN_CROP, AGRO_CALENDAR_INVALID_WINDOW '
                + '(including a window that carries a citation), AGRO_CALENDAR_SOWING_NEEDS_BAND, '
                + 'AGRO_CALENDAR_BASIS_REQUIRED, AGRO_CALENDAR_WINDOW_OF_ANOTHER_CROP.',
            404: 'Not the platform-support tenant.',
        }),
        success: { status: 200, description: 'The override as stored.', schema: z.object({ override: Override }) },
    });

    op(registry, {
        method: 'delete',
        path: '/api/t/{tenantSlug}/admin/agro-calendar/overrides/{windowId}',
        operationId: 'clearAgroCalendarOverride',
        summary: 'Clear a window\'s override',
        description:
            'A correction gives МЗХ\'s cited window back; an addition disappears. Audited.' + DOORS,
        tags: ['Admin'],
        params: WindowParams,
        extraResponses: codedErrorResponses({
            404: '`AGRO_CALENDAR_OVERRIDE_NOT_FOUND` — nothing is live on that window — or not the platform-support tenant.',
        }),
        success: { status: 204, description: 'Cleared.' },
    });

    const KEYED =
        '\n\n**The keyed door, for scripts.** Gated by the shared `PLATFORM_ADMIN_API_KEY` '
        + '(`x-platform-admin-key`), in `PUBLIC_PATH_PREFIXES` because the Edge understands only a '
        + 'session cookie. The author recorded is the key GENERATION (`platform-key:current`), not a '
        + 'person (#1619, #2735). The phone uses the session door under `/api/t/{tenantSlug}/admin`.';
    const KeyedErrors = {
        401: { description: 'No or wrong `x-platform-admin-key`.' },
        503: { description: 'The platform admin API is not configured.' },
    };

    op(registry, {
        method: 'get',
        path: '/api/admin/agro-calendar/overrides',
        operationId: 'listAgroCalendarOverridesKeyed',
        summary: 'Live overrides of the agro calendar (keyed)',
        description: 'As `listAgroCalendarOverrides`.' + KEYED,
        tags: ['Admin'],
        extraResponses: KeyedErrors,
        success: { status: 200, description: 'The live overrides.', schema: z.object({ overrides: z.array(Override) }) },
    });

    op(registry, {
        method: 'put',
        path: '/api/admin/agro-calendar/overrides',
        operationId: 'setAgroCalendarOverrideKeyed',
        summary: 'Correct or add a calendar window (keyed)',
        description: 'As `setAgroCalendarOverride`; an unreadable body is `{ error: "invalid_request" }`.' + KEYED,
        tags: ['Admin'],
        body: z.object({
            cropKey: z.string(),
            window: Window,
            basis: z.object({ bg: z.string().min(1).max(1000), en: z.string().max(1000).nullable().optional() }),
        }),
        extraResponses: {
            ...KeyedErrors,
            ...codedErrorResponses({ 400: 'invalid_request, or one of the AGRO_CALENDAR_* codes of the session door.' }),
        },
        success: { status: 200, description: 'The override as stored.', schema: z.object({ override: Override }) },
    });

    op(registry, {
        method: 'delete',
        path: '/api/admin/agro-calendar/overrides/{windowId}',
        operationId: 'clearAgroCalendarOverrideKeyed',
        summary: 'Clear a calendar window\'s override (keyed)',
        description: 'As `clearAgroCalendarOverride`.' + KEYED,
        tags: ['Admin'],
        params: z.object({ windowId: z.string().openapi({ param: { name: 'windowId', in: 'path' } }) }),
        extraResponses: { ...KeyedErrors, ...codedErrorResponses({ 404: '`AGRO_CALENDAR_OVERRIDE_NOT_FOUND`.' }) },
        success: { status: 204, description: 'Cleared.' },
    });
}

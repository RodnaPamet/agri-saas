/**
 * Account — the per-user surfaces, which are NOT tenant-scoped.
 *
 * Every other module here documents `/api/t/{tenantSlug}/…`. These two carry
 * no tenant in the path because what they store is a property of the PERSON:
 * the bottom-row arrangement is a list of route suffixes, and a suffix means
 * the same thing in every tenant the user belongs to.
 *
 * They are documented as a PAIR, and that is the point of the module. The
 * write endpoint has deliberately no GET — a client reads its arrangement
 * from `/api/auth/me`, the request it already makes at launch — so describing
 * only one half would leave a native client with a setter and no getter and
 * no clue where the value lives. `/api/auth/me` came off the undocumented
 * baseline in the same change.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { MAX_BOTTOM_TABS } from '@/lib/account/bottom-tabs';
import { op } from './helpers';

/**
 * The stored arrangement, in both directions.
 *
 * `.nullable()` is load-bearing documentation, not defensive typing: `null`
 * and `[]` are DIFFERENT states on the wire. `null` means "never chosen, draw
 * the default bar"; `[]` means "deliberately cleared". A client that collapses
 * them makes a new user indistinguishable from one who emptied their bar.
 */
const BottomTabOrder = z
    .array(z.string())
    .max(MAX_BOTTOM_TABS)
    .nullable()
    .openapi('BottomTabOrder', {
        description:
            'Ordered tenant-relative route suffixes — `/dashboard`, `/farm-tasks`, ' +
            '`/grain/costs`. Validated for SHAPE only: up to ' +
            `${MAX_BOTTOM_TABS} unique non-empty strings, never against a list of known ` +
            'tabs, so a tab shipped by a newer client saves against an older server. ' +
            'It is a PREFERENCE, not a grant — resolve it against the surfaces the ' +
            'member may actually reach on EVERY render, because a role can change ' +
            'after the write. `null` and `[]` are different states (see schema).',
        example: ['/dashboard', '/farm-tasks', '/locations', '/journal', '/exchange'],
    });

export function registerAccountPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/auth/me',
        operationId: 'getCurrentUser',
        summary: 'The signed-in user, their primary tenant, and their preferences',
        description:
            'The launch request. Returns the caller plus their OLDEST ACTIVE membership as ' +
            '`tenant` — one membership, not the list, so a user who belongs to several ' +
            'tenants cannot pick between them here. `role` falls back to `READER` when ' +
            'there is no active membership, so it is not proof of access on its own. ' +
            'Carries `bottomTabOrder`, which is why a client needs no second round-trip ' +
            'before drawing its tab bar. Answers a BEARER token as well as a cookie.',
        tags: ['Account'],
        success: {
            status: 200,
            description: 'The caller. `tenant` is null when they have no active membership.',
            schema: z
                .object({
                    user: z.object({
                        id: z.string(),
                        email: z.string().nullable(),
                        name: z.string().nullable(),
                        role: z.string(),
                        bottomTabOrder: BottomTabOrder,
                    }),
                    tenant: z
                        .object({ id: z.string(), name: z.string(), slug: z.string() })
                        .nullable(),
                })
                .openapi('CurrentUser'),
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/account/bottom-tabs',
        operationId: 'setBottomTabOrder',
        summary: "Set the caller's own bottom-row arrangement",
        description:
            'Acts ONLY on the authenticated user — there is no userId parameter, so one ' +
            'user can never rearrange another\'s bar. Send `{ "order": [...] }` to set it, ' +
            '`{ "order": null }` to restore the default, `{ "order": [] }` for a ' +
            'deliberately empty bar. The key is REQUIRED: a missing `order` is rejected ' +
            'rather than guessed at, because null and [] mean opposite things. ' +
            'Last-write-wins — no `If-Match`, matching the other account preferences. ' +
            'Read the value back from `getCurrentUser`; there is no GET here.',
        tags: ['Account'],
        body: z.object({ order: BottomTabOrder }).openapi('SetBottomTabOrderRequest'),
        success: {
            status: 200,
            description: 'The stored arrangement, as persisted.',
            schema: z.object({ bottomTabOrder: BottomTabOrder }),
        },
    });
}

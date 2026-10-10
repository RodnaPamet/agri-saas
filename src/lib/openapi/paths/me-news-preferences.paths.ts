/**
 * `/api/me/news-preferences` — the reader's own Новини tag opt-ins (#231 §4).
 *
 * Its own module rather than appended to `me-farms.paths.ts`. That file's
 * docblock invites "the next `/api/me/` route", and the invitation is about
 * keeping the *reasoning* for the person-scoped route class together — but the
 * file is named for farms, and a news preference documented inside it is the
 * kind of misfiling nobody finds later. The shared reasoning it points at
 * (no tenant, no `requirePermission`, the subject is always the session user)
 * is restated below where it actually applies.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { op } from './helpers';

const TagList = z.array(z.string()).openapi({
    description:
        'Tag keys from `GET /api/t/{tenantSlug}/trends/news/tags`. Order is the reader’s own and is not significant.',
    example: ['wheat', 'subsidies'],
});

const NewsPreferencesSchema = z
    .object({
        tags: TagList.nullable().openapi({
            description:
                '`null` means the reader has NEVER CHOSEN; `[]` means they chose nothing. Both show the full feed, so the difference does not affect filtering — it tells a client whether it may prompt. Do not collapse them: a brand-new reader and one who deliberately cleared their choices want opposite treatment.',
        }),
    })
    .openapi('NewsPreferences', {
        description:
            'One person’s Новини tag opt-ins. Stored on the server so the same choices apply on web and on every phone, but NEVER applied to the feed implicitly — read them, then pass them to `GET /trends/news?tags=` yourself. The feed is cached under a key shared by every reader, so a server that filtered by the caller’s own preferences would serve one person’s feed to everybody else.',
    });

/**
 * The PUT response, where `tags` is NOT nullable.
 *
 * The contract spells the two responses differently on purpose — `GET` is
 * `string[] | null`, `PUT` is `string[]` — and that is accurate rather than
 * sloppy: a PUT has just written an array, so there is no "never chose" state
 * left to report. Sharing one nullable schema would have been simpler and
 * would have told a codegen client to handle a null that cannot occur.
 */
const NewsPreferencesStoredSchema = z
    .object({ tags: TagList })
    .openapi('NewsPreferencesStored', {
        description:
            'The list as persisted. Never null — a PUT has just written an array, so the "never chose" state of the GET response is not reachable here.',
    });

const NewsPreferencesBody = z
    .object({ tags: TagList })
    .openapi('NewsPreferencesUpdate', {
        description:
            'Replaces the stored list wholesale. Send `[]` to clear — that is a choice and is stored as one. Duplicates are collapsed.',
    });

export function registerMeNewsPreferencesPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'get',
        path: '/api/me/news-preferences',
        operationId: 'getMyNewsPreferences',
        summary: 'Новини — the signed-in reader’s own tag opt-ins',
        description:
            'Account-level, with no `{tenantSlug}`: a news preference is a property of the PERSON, not of a farm. The same person reading the same global feed from two farms wants the same tags, and scoping this to a tenant would invite exactly the bug where switching farms silently changes your feed. The subject is always the session user — there is no id parameter and no body — so one person can never read another’s. ' +
            '\n\nA tag the server no longer recognises is DROPPED from the response rather than returned or 400ed. Tags get renamed, and a stored list validated only when it was written would otherwise filter a feed down to nothing with no way for the reader to see why.',
        tags: ['Trends'],
        success: {
            status: 200,
            description:
                'The stored list. `tags: null` for a reader who has never chosen — distinct from `[]`.',
            schema: NewsPreferencesSchema,
        },
    });

    op(registry, {
        method: 'put',
        path: '/api/me/news-preferences',
        operationId: 'setMyNewsPreferences',
        summary: 'Новини — replace the signed-in reader’s tag opt-ins',
        description:
            'Replaces the stored list for the session user. ' +
            '\n\n**400s on a tag outside the catalogue, naming it** — deliberately the OPPOSITE of `?tags=` on the feed, which ignores unknown keys. The two answer different questions about who chose the value: a `PUT` is a person choosing, where a typo is a client bug worth surfacing, while the feed parameter is a pass-through of state the server itself issued and may since have renamed. Reject unknown on write, ignore unknown on read. ' +
            '\n\nThe 400 carries `code: "INVALID_NEWS_PREFERENCES"`.',
        tags: ['Trends'],
        body: NewsPreferencesBody,
        success: {
            status: 200,
            description: 'The stored list, as persisted. `tags` is never null here.',
            schema: NewsPreferencesStoredSchema,
        },
    });
}

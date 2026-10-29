/**
 * The Google Calendar sync (#2020).
 *
 * Its own file rather than an entry appended to an existing one: every other
 * `/admin/integrations/google` route is on the undocumented baseline, and that
 * baseline only shrinks — so this is the first documented route of the family
 * and the place a future Drive-sync entry belongs.
 *
 * The response is documented in detail because two of its fields are
 * CONTRACTS rather than statistics: `partial` says the sync declined to
 * delete, and `skippedEdited` says the farmer's own edits were left alone.
 * A client that renders "synced" over either one is reporting a clean run it
 * did not have.
 */
import { z } from '@/lib/openapi/zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { codedErrorResponses, op } from './helpers';

const TenantParams = z.object({ tenantSlug: z.string() });

const CalendarSync = z
    .object({
        calendarId: z.string().openapi({
            description: 'Google’s id for the «Agrent — Срокове» calendar this farm writes into.',
        }),
        calendarCreated: z.boolean().openapi({
            description:
                'True when THIS run made the calendar — the first sync, or because the farmer had '
                + 'deleted the previous one. Deleting it is the documented way to reset this '
                + 'integration, so a `true` here on an established farm is an ordinary event '
                + 'rather than a fault.',
        }),
        created: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative().openapi({
            description:
                'Events already correct. Counted so a no-op sync is distinguishable from one that '
                + 'did nothing because it failed to read anything.',
        }),
        skippedEdited: z.number().int().nonnegative().openapi({
            description:
                'Events the farmer had edited, left untouched — NOT updated and NOT deleted. '
                + 'Their edit is authoritative: an edited event has been repurposed, so '
                + 'withdrawing it because the original deadline moved on would destroy their work. '
                + '**Surface this.** A non-zero count means the calendar deliberately disagrees '
                + 'with the farm, and a client reporting a clean sync over it is wrong.',
        }),
        partial: z.boolean().openapi({
            description:
                'True when deletion was SUPPRESSED because the source read was truncated. '
                + '**Read it.** Creates and updates still ran, but the calendar may hold an event '
                + 'the farm no longer has, and a truncated run is indistinguishable from a '
                + 'complete one without this field.',
        }),
        locale: z.string().openapi({
            description:
                'The language the event titles were written in, `bg` or `en`. Fixed when the '
                + 'calendar is created and reused thereafter, so the titles do not change with '
                + 'whichever administrator pressed sync last.',
            example: 'bg',
        }),
    })
    .openapi('GoogleCalendarSync');

export function registerGoogleCalendarPaths(registry: OpenAPIRegistry): void {
    op(registry, {
        method: 'post',
        path: '/api/t/{tenantSlug}/admin/integrations/google/calendar/sync',
        operationId: 'syncGoogleCalendar',
        summary: 'Bring the farm’s Google Calendar into line with its deadlines',
        description:
            'Writes the farm’s dated work — task due dates, lease expiry, contract delivery '
            + 'windows, planting cycles, support-scheme deadlines and the rest of the nine '
            + 'calendar sources — into a separate «Agrent — Срокове» calendar in the connected '
            + 'Google account.\n\n'
            + 'A **sync**, not a push: the desired set is computed, the calendar is read back, '
            + 'and the difference is applied. Task due dates and lease expiry move, so a push '
            + 'would leave the farmer planning around dates that no longer exist.\n\n'
            + '**Safe to repeat.** A second call finds every event already matching and reports '
            + 'it as `unchanged` — a property of the diff, so no idempotency key is involved.\n\n'
            + '**Two things it deliberately will not do, and both are reported rather than '
            + 'hidden:**\n\n'
            + '| situation | what happens | field |\n'
            + '| --- | --- | --- |\n'
            + '| the source read was truncated | nothing is deleted | `partial: true` |\n'
            + '| the farmer edited one of our events | it is neither updated nor deleted | `skippedEdited` |\n\n'
            + 'In both cases an absence from the desired set is not evidence that the farm no '
            + 'longer wants the event, and a sync that deleted on it would destroy real '
            + 'information. Events outside the sync’s own window — 30 days back, a year '
            + 'forward — are left alone for the same reason, which is what stops a rolling '
            + 'window from erasing the farm’s history.\n\n'
            + 'Administrator only, and behind the `integrations.google` flag. The credential is '
            + 'a tenant-wide secret, so the sync cannot be more open than the token resolver '
            + 'that decrypts it.',
        tags: ['Integrations'],
        params: TenantParams,
        success: { status: 200, description: 'What the sync did.', schema: CalendarSync },
        extraResponses: {
            ...codedErrorResponses({
                400:
                    '`GOOGLE_NOT_CONNECTED` — no Google account is connected for this farm. '
                    + '`GOOGLE_CALENDAR_NOT_GRANTED` — a connection exists but Calendar was not '
                    + 'granted, which is an ordinary state because Google’s consent screen lets '
                    + 'the scopes be ticked individually; the remedy is to reconnect and grant '
                    + 'Calendar. `GOOGLE_GRANT_REVOKED` — the stored grant is no longer '
                    + 'authorised. `GOOGLE_CALENDAR_REFUSED` — Google refused the write for some '
                    + 'other reason, a rate limit among them; retry shortly rather than '
                    + 'reconnecting a connection that is fine.',
            }),
        },
    });
}

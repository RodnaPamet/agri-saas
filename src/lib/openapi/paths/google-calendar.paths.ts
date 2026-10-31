/**
 * The documented `/admin/integrations/google` routes — the calendar sync
 * (#2020) and the consent start (#2495 step 6).
 *
 * It began as the calendar sync alone, when every other route of the family
 * sat on the undocumented baseline and this was the first documented one. The
 * connect route joined it rather than getting a file of its own, because that
 * baseline only shrinks and a reader looking for "what can I call on the Google
 * integration" should find one place.
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
        path: '/api/t/{tenantSlug}/admin/integrations/google/connect',
        operationId: 'startGoogleConnect',
        summary: 'Start the Google consent flow for Drive and Calendar',
        description:
            'Answers with the Google authorize URL to open. TWO branches, chosen by `client`, '
            + 'and they differ in where the consent is RETURNED rather than in what is granted.\n\n'
            + '**Web — no body, or any `client` but `ios`.** Also sets a short-lived HttpOnly '
            + '`google_oauth_state` cookie; the browser navigates to the URL and Google returns to '
            + 'the callback, which verifies the state against that cookie and lands the person back '
            + 'on the admin integrations page.\n\n'
            + '**Native — `{"client":"ios"}`.** Sets NO cookie. The state is a server-held '
            + 'single-use nonce bound to this farm and this administrator, and the callback returns '
            + 'control to the app rather than to a web page.\n\n'
            + 'The cookie cannot serve a native client and that is a fact about the platform rather '
            + 'than a preference: the consent runs in an EPHEMERAL `ASWebAuthenticationSession`, a '
            + 'different cookie jar from the one the app’s HTTP client put this response’s cookie '
            + 'in. The callback would never see it, so every attempt would fail the state check — '
            + 'and even a success would land on a web page instead of back in the app.\n\n'
            + '**A native caller does not choose where it is returned to.** The target is a server '
            + 'constant, validated against the deployment’s native redirect allowlist when the '
            + 'state is issued. A caller-supplied target would make the callback an open redirect '
            + 'gated only by an allowlist; this way the flow carries no caller-controlled value at '
            + 'all. A deployment whose allowlist does not carry the app scheme refuses with 400 '
            + '`GOOGLE_NATIVE_RETURN_NOT_ALLOWED` at this call rather than minting a state whose '
            + 'return the device would silently drop.\n\n'
            + '**The native callback answers on the app scheme**, `?result=connected` or '
            + '`?error=<code>` from a CLOSED set: `access_denied`, `insufficient_scope`, '
            + '`state_expired`, `state_invalid`, `token_exchange_failed`, `not_admin`, '
            + '`internal_error`. Closed because a client treats an unlisted value as an internal '
            + 'error, so an unmapped string is not a message but a value it discards.\n\n'
            + '`insufficient_scope` means DRIVE specifically was not granted, not that nothing '
            + 'was. Google’s consent screen lets the scopes be ticked individually, so a '
            + 'calendar-only grant is an ordinary outcome — and reporting it as connected would '
            + 'contradict `GET /documents/settings`, which reports `google.connected: false` for '
            + 'exactly that case.\n\n'
            + 'Administrator only, and behind the `integrations.google` flag — both branches.',
        tags: ['Integrations'],
        params: TenantParams,
        body: z
            .object({
                client: z
                    .literal('ios')
                    .optional()
                    .openapi({
                        description:
                            'Omit for the web flow. `"ios"` selects the native branch: no cookie, '
                            + 'a server-held nonce, and an app-scheme return.',
                    }),
            })
            .openapi('GoogleConnectRequest'),
        success: {
            status: 200,
            description: 'The URL to open for consent.',
            schema: z
                .object({ authorizeUrl: z.string() })
                .openapi('GoogleConnectStart'),
        },
        extraResponses: codedErrorResponses({
            400:
                '`GOOGLE_NATIVE_RETURN_NOT_ALLOWED` — a native consent was requested on a '
                + 'deployment whose native redirect allowlist does not carry the app scheme. '
                + 'Refused HERE rather than at the callback, because a state minted against an '
                + 'unreachable return would leave the person watching a consent that completed and '
                + 'went nowhere. Configuration, not a bad client: the operator sets the allowlist.',
        }),
    });

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

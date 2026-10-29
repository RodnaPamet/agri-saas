/**
 * Writing the farm's deadlines into Google Calendar — #2020.
 *
 * The grant, its refresh and its storage are `token.ts` and `service.ts`.
 * This is the Calendar API surface: a calendar of our own, and the events in
 * it. Shaped after `drive.ts` so the two providers read the same way.
 *
 * ## A SYNC, not a push — owner's decision, 2026-10-29
 *
 * A push writes an event and forgets it, which is wrong the moment a date
 * moves: a lease expiry that shifts leaves the farmer planning around a date
 * that no longer exists. Of the sources #2020 names, task due dates and lease
 * expiry both move, so most of the value would be gone.
 *
 * ## The mapping lives ON the event, not in our database
 *
 * #2020 proposed `configJson` or a new table. Neither is needed. Calendar
 * supports `extendedProperties.private` and an
 * `events.list?privateExtendedProperty=` filter, so each event carries the
 * app's own stable id — `TASK:123:task-due`, which `getCalendarEvents`
 * already mints. That means:
 *
 *   - no migration, and no second record of what we wrote;
 *   - the mapping cannot drift from reality, because it IS reality;
 *   - deleting the Agrent calendar removes the mapping with it, so the
 *     integration stays revocable by one action in the farmer's own UI.
 *
 * Only the calendar's own id is stored on the connection, which is one value
 * and exactly what `configJson` is for — the same shape as `driveFolderId`.
 *
 * ## A calendar of our own
 *
 * Writing into the primary calendar mixes the app's events with the person's
 * life and cannot be undone as a set. A separate "Agrent" calendar is
 * removable in one gesture, colour-codable, and makes `events.list` cheap
 * because the only events in it are ours.
 *
 * ## Two traps in this API, both encoded below
 *
 * **An all-day `end.date` is EXCLUSIVE.** A deadline on the 5th is
 * `start.date = 2026-11-05`, `end.date = 2026-11-06`. Writing the same date
 * for both yields an event Calendar renders as empty or drops, and every
 * single-day deadline — which is most of them — would be affected.
 *
 * **The day must be computed in Europe/Sofia, not sliced off the ISO
 * string.** `CalendarEvent.date` is an instant, and several agriculture
 * sources carry a real time of day: a task due at 01:00 Sofia on the 5th is
 * 22:00 UTC on the 4th, so `date.slice(0, 10)` buckets it onto the previous
 * day. `dayKeyInTz` exists for exactly this and is reused rather than
 * reimplemented.
 */

import { createHash } from 'crypto';

import { codedBadRequest, externalServiceError } from '@/lib/errors/types';
import { FARM_TIME_ZONE, dayKeyInTz } from '@/lib/calendar-day-key';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Our id, as stored on each event. */
export const AGRENT_ID_PROPERTY = 'agrentId';

/**
 * A fingerprint of the fields WE wrote, so a farmer's own edit is detectable.
 *
 * Without it there is no way to tell "we have not written this yet" from "the
 * farmer changed the title and we are about to overwrite them". Their edit is
 * authoritative — they are the person using the calendar — so an event whose
 * current content no longer matches what we last wrote is left alone.
 */
export const AGRENT_HASH_PROPERTY = 'agrentHash';

/**
 * The one place a Calendar HTTP status becomes a coded refusal.
 *
 * Separate from `drive.ts`'s mapping rather than shared, because the MESSAGES
 * differ in the only way that matters to a farmer: one says to grant Drive and
 * the other to grant Calendar, and the remedy for a 403 is a different screen.
 * `GOOGLE_GRANT_REVOKED` is genuinely the same condition and keeps its code.
 */
async function refuseCalendar(res: Response, what: string): Promise<never> {
    if (res.status === 401) {
        throw codedBadRequest(
            'GOOGLE_GRANT_REVOKED',
            'The Google connection is no longer authorised. Reconnect it to sync the calendar.',
        );
    }
    if (res.status === 403) {
        // Read the reason rather than assume it. A 403 here is usually a
        // missing scope, but Calendar also 403s a rate limit — and telling
        // somebody to reconnect a working connection is wrong advice.
        const detail = await res.text().catch(() => '');
        if (/insufficient|scope|forbidden for non-organizer/i.test(detail)) {
            throw codedBadRequest(
                'GOOGLE_CALENDAR_NOT_GRANTED',
                'The Google connection does not include Calendar access. Reconnect it and grant Calendar.',
            );
        }
        throw codedBadRequest(
            'GOOGLE_CALENDAR_REFUSED',
            'Google refused the calendar write. Try again shortly.',
        );
    }
    throw externalServiceError(`Google Calendar ${what} failed with ${res.status}.`);
}

interface Deps {
    fetchImpl?: typeof fetch;
}

function authHeaders(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}

export interface FarmCalendar {
    calendarId: string;
    /**
     * True when this call made the calendar — the first sync, or because the
     * farmer deleted the previous one. The caller persists the id on `true`.
     */
    created: boolean;
}

/**
 * The calendar we write into, created when the stored id names nothing usable.
 *
 * A 404 on the stored id is an ORDINARY state, not a failure: the farmer is
 * entitled to delete a calendar from their own account, and that is in fact
 * the documented way to revoke this integration. Reporting it as an error
 * would tell someone to reconnect a connection that is fine.
 */
export async function ensureFarmCalendar(
    accessToken: string,
    storedCalendarId: string | null,
    opts: { name: string; fetchImpl?: typeof fetch },
): Promise<FarmCalendar> {
    const fetchImpl = opts.fetchImpl ?? fetch;

    if (storedCalendarId) {
        const res = await fetchImpl(
            `${CALENDAR_API}/calendars/${encodeURIComponent(storedCalendarId)}`,
            { headers: authHeaders(accessToken) },
        );
        if (res.ok) {
            const json = (await res.json().catch(() => null)) as { id?: string } | null;
            if (json?.id) return { calendarId: json.id, created: false };
        } else if (res.status !== 404 && res.status !== 410) {
            // 410 Gone is what Calendar answers for a deleted calendar, and it
            // means the same ordinary thing as 404 here. Anything else keeps
            // its own meaning.
            await refuseCalendar(res, 'calendar lookup');
        }
    }

    const res = await fetchImpl(`${CALENDAR_API}/calendars`, {
        method: 'POST',
        headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
        // The zone is set on the CALENDAR as well as on each event. An
        // all-day event carries no zone of its own, so the calendar's is what
        // decides which day a viewer in another zone sees.
        body: JSON.stringify({ summary: opts.name, timeZone: FARM_TIME_ZONE }),
    });
    if (!res.ok) await refuseCalendar(res, 'calendar create');

    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!json?.id) {
        // Proceeding without an id would write the farm's deadlines into the
        // primary calendar, which is the thing a separate calendar exists to
        // prevent.
        throw externalServiceError('Google Calendar created a calendar but returned no id.');
    }
    return { calendarId: json.id, created: true };
}

export interface ExistingEvent {
    /** Google's event id. */
    eventId: string;
    /** Our stable id, from `extendedProperties.private.agrentId`. */
    agrentId: string;
    /** The fingerprint we wrote, or null on an event written before this existed. */
    writtenHash: string | null;
    /** What the event says NOW — used to detect a farmer's own edit. */
    currentHash: string;
}

/**
 * Every event in the calendar that WE wrote, by our own id.
 *
 * Filtered on our extended property rather than listing everything, so a
 * calendar a farmer has also put their own events into is not disturbed and
 * not paged through.
 *
 * Paginated deliberately: a farm with two years of deadlines across nine
 * sources exceeds one page, and a single-page read would silently treat the
 * remainder as absent — then recreate every one of them as a duplicate.
 */
export async function listFarmEvents(
    accessToken: string,
    calendarId: string,
    deps: Deps = {},
): Promise<ExistingEvent[]> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const out: ExistingEvent[] = [];
    let pageToken: string | undefined;

    // A bound, so a pathological account cannot spin here forever. 20 pages
    // at 250 events is 5,000 — far above any real farm, and finite.
    for (let page = 0; page < 20; page++) {
        // NOT filtered on `privateExtendedProperty`, and that is deliberate.
        //
        // The API matches that parameter as an exact `key=value`; it has no
        // wildcard, so "any event carrying our id" is not expressible as a
        // filter. The alternative would be one request per id, which is the
        // opposite of what paging is for.
        //
        // So the page is read whole and events without our property are
        // discarded below. That is cheap precisely BECAUSE the calendar is
        // ours: the discard set is normally empty, and when it is not, those
        // are the farmer's own events — which must be left alone anyway.
        const q = new URLSearchParams({ maxResults: '250', showDeleted: 'false' });
        if (pageToken) q.set('pageToken', pageToken);

        const res = await fetchImpl(
            `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`,
            { headers: authHeaders(accessToken) },
        );
        if (!res.ok) await refuseCalendar(res, 'event list');

        const json = (await res.json().catch(() => null)) as {
            items?: Array<{
                id?: string;
                summary?: string;
                start?: { date?: string; dateTime?: string };
                end?: { date?: string; dateTime?: string };
                extendedProperties?: { private?: Record<string, string> };
            }>;
            nextPageToken?: string;
        } | null;

        for (const item of json?.items ?? []) {
            const priv = item.extendedProperties?.private ?? {};
            const agrentId = priv[AGRENT_ID_PROPERTY];
            // Not ours — a farmer may keep their own events in this calendar,
            // and those are never touched.
            if (!item.id || !agrentId) continue;
            out.push({
                eventId: item.id,
                agrentId,
                writtenHash: priv[AGRENT_HASH_PROPERTY] ?? null,
                currentHash: contentFingerprint({
                    summary: item.summary ?? '',
                    startDay: item.start?.date ?? item.start?.dateTime ?? '',
                    endDayExclusive: item.end?.date ?? item.end?.dateTime ?? '',
                }),
            });
        }

        pageToken = json?.nextPageToken;
        if (!pageToken) break;
    }
    return out;
}

export interface FarmEventContent {
    summary: string;
    /** `YYYY-MM-DD` in Europe/Sofia. */
    startDay: string;
    /** `YYYY-MM-DD`, EXCLUSIVE — the day after the last day of the event. */
    endDayExclusive: string;
}

/** A short digest of exactly the fields we write, and nothing else. */
export function contentFingerprint(c: FarmEventContent): string {
    return createHash('sha256')
        .update(`${c.summary} ${c.startDay} ${c.endDayExclusive}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * The all-day span for a deadline, in the farm's zone.
 *
 * `end.date` is EXCLUSIVE in the Calendar API — a one-day event on the 5th
 * ends on the 6th. Writing the same date for both produces an event Calendar
 * renders as empty, which would affect every single-day deadline, i.e. most
 * of them.
 *
 * Both days are computed with `dayKeyInTz`, never by slicing the ISO string:
 * a task due at 01:00 Sofia on the 5th is 22:00 UTC on the 4th.
 */
export function allDaySpan(startInstant: string, endInstant?: string): {
    startDay: string;
    endDayExclusive: string;
} {
    const startDay = dayKeyInTz(startInstant, FARM_TIME_ZONE);
    const lastDay = endInstant ? dayKeyInTz(endInstant, FARM_TIME_ZONE) : startDay;
    // +1 day on the CALENDAR day, computed through Date so a month or year
    // boundary is handled rather than string-incremented.
    const next = new Date(`${lastDay}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return { startDay, endDayExclusive: next.toISOString().slice(0, 10) };
}

function eventBody(agrentId: string, content: FarmEventContent): unknown {
    return {
        summary: content.summary,
        start: { date: content.startDay, timeZone: FARM_TIME_ZONE },
        end: { date: content.endDayExclusive, timeZone: FARM_TIME_ZONE },
        extendedProperties: {
            private: {
                [AGRENT_ID_PROPERTY]: agrentId,
                [AGRENT_HASH_PROPERTY]: contentFingerprint(content),
            },
        },
    };
}

/** Create one event. */
export async function createFarmEvent(
    accessToken: string,
    calendarId: string,
    agrentId: string,
    content: FarmEventContent,
    deps: Deps = {},
): Promise<string> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
        {
            method: 'POST',
            headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(eventBody(agrentId, content)),
        },
    );
    if (!res.ok) await refuseCalendar(res, 'event create');
    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!json?.id) {
        // A create that reports no id cannot be correlated on the next sync,
        // so the next run would create it again. Better to fail the run.
        throw externalServiceError('Google Calendar created an event but returned no id.');
    }
    return json.id;
}

/** Replace one event's content, keeping its id. */
export async function updateFarmEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    agrentId: string,
    content: FarmEventContent,
    deps: Deps = {},
): Promise<void> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        {
            // PUT, not PATCH: the body is the complete set of fields we own,
            // and a PATCH would leave a stale `agrentHash` if the summary
            // changed but the hash key were omitted.
            method: 'PUT',
            headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(eventBody(agrentId, content)),
        },
    );
    if (!res.ok) await refuseCalendar(res, 'event update');
}

/**
 * Remove one event.
 *
 * A 404 or 410 is SUCCESS: the farmer deleted it themselves, which is the
 * outcome this call wanted. Treating it as an error would make every sync
 * after a manual tidy-up report a failure.
 */
export async function deleteFarmEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    deps: Deps = {},
): Promise<void> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(
        `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE', headers: authHeaders(accessToken) },
    );
    if (res.ok || res.status === 404 || res.status === 410) return;
    await refuseCalendar(res, 'event delete');
}

/**
 * Has the farmer edited this event since we wrote it?
 *
 * Their edit wins. They are the person using the calendar, and an app that
 * silently reverts a human's change to their own data is worse than one that
 * leaves a deadline slightly stale — they can always delete the event to get
 * ours back.
 *
 * `writtenHash === null` means an event from before this fingerprint existed.
 * Treated as NOT edited, deliberately: the alternative is to abandon every
 * such event forever, and the rule should fail towards keeping the calendar
 * correct rather than towards freezing it.
 */
export function wasEditedByUser(e: ExistingEvent): boolean {
    if (e.writtenHash === null) return false;
    return e.currentHash !== e.writtenHash;
}

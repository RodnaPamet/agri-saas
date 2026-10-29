/**
 * Keep a farmer's Google Calendar MATCHING the farm's deadlines — #2020.
 *
 * Follow-up B to #2005 (the consent flow) and sibling to
 * `farm-record-drive-export.ts` (#2019). The Calendar API surface is
 * `integrations/providers/google/calendar.ts`; this is the orchestration.
 *
 * ## A sync, not a push — owner's decision, 2026-10-29
 *
 * A push writes an event and forgets it. Of the nine sources
 * `getCalendarEvents` reads, task due dates, lease expiry and contract
 * delivery windows all MOVE, so a push leaves the farmer planning around
 * dates that no longer exist — and the longer it runs the less the calendar
 * means. So: a desired set is computed, the calendar is read back, and the
 * difference is applied.
 *
 * ## Absence is not evidence — the one property worth reading twice
 *
 * A sync deletes what is no longer wanted, which means it has to be sure that
 * "not in the desired set" actually means "no longer wanted". There are two
 * ways for it to mean something else, and both are silent:
 *
 *  1. **The window.** The sources are read over a bounded range, because a
 *     sync that read every deadline a farm has ever had would grow without
 *     limit. An event that has aged out of that range is absent from the
 *     desired set for a reason that has nothing to do with the farmer. Deleting
 *     it would make every sync quietly destroy the farm's own history — and
 *     the first run after a window change would do it wholesale.
 *  2. **Truncation.** `getCalendarEvents` caps each source at
 *     `perSourceLimit` and reports `truncated` when it had to. A truncated
 *     desired set is INCOMPLETE, so every event it dropped looks deleted.
 *
 * So deletion is bounded on both axes: an existing event is removed only when
 * its own start day falls INSIDE the window, and only when the read was not
 * truncated. Where either fails the sync still creates and updates — it just
 * declines to conclude anything from an absence. `partial` says so, because a
 * sync that silently did two thirds of its job is the thing being avoided.
 *
 * ## The farmer's own edit wins, and that includes not deleting it
 *
 * `wasEditedByUser` compares the event's current content against the
 * fingerprint we last wrote. A mismatch means they changed it, and they are
 * the person using the calendar. Such an event is skipped for UPDATE — and
 * for DELETE too, which is the less obvious half: an edited event has been
 * repurposed, so removing it because the original deadline moved on destroys
 * their work rather than ours. They can always delete it themselves.
 *
 * ## The language is PERSISTED, not resolved per sync
 *
 * `CalendarEvent.titleKey` is an i18n key resolved by the renderer, so a sync
 * has to resolve the copy itself — there is no renderer here. Whose language,
 * though? `IntegrationConnection` has no `createdByUserId`, so the connecting
 * user is not recoverable, and using the CALLER's language would mean two
 * admins with different preferences flip every title back and forth, rewriting
 * every event on every alternate sync.
 *
 * So the locale is written alongside the calendar id when the calendar is
 * created, and read thereafter. Same argument as the oldest-connection rule
 * next door: the destination should be STABLE, and a farmer who wants it
 * changed has a gesture already — delete the calendar, which is the documented
 * way to reset this integration.
 *
 * @module usecases/calendar-google-sync
 */

import type { Prisma } from '@prisma/client';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanAdmin } from '../policies/common';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { logEvent } from '../events/audit';
import { codedBadRequest } from '@/lib/errors/types';
import { FARM_TIME_ZONE, dayKeyInTz } from '@/lib/calendar-day-key';
import { translateFor } from '@/lib/i18n/server-messages';
import { resolveRecipientLocale } from '@/lib/email/recipient-locale';
import { isLocale, type Locale } from '@/lib/i18n/locales';
import {
    GOOGLE_INTEGRATION_FLAG,
    resolveGoogleConnectionToken,
    type GoogleConfigJson,
} from '../integrations/providers/google/service';
import { GOOGLE_PROVIDER } from '../integrations/providers/google/token';
import {
    allDaySpan,
    contentFingerprint,
    createFarmEvent,
    deleteFarmEvent,
    ensureFarmCalendar,
    listFarmEvents,
    updateFarmEvent,
    wasEditedByUser,
    type FarmEventContent,
} from '../integrations/providers/google/calendar';
import { getCalendarEvents } from './calendar';

/**
 * The calendar as it appears in the farmer's own Google account.
 *
 * Latin brand plus a Bulgarian noun, the `DRIVE_FOLDER_NAME` convention.
 * Addressed by stored id, so renaming this later orphans nothing — only a
 * calendar created after the change takes the new name.
 */
export const CALENDAR_NAME = 'Agrent — Срокове';

/**
 * How far back and forward the sync looks.
 *
 * Backwards is short: a calendar is for what is coming, and 30 days keeps a
 * recently-missed deadline visible without re-reading seasons nobody is
 * planning around. Forwards is a year because the longest-dated sources —
 * lease expiry, support-scheme deadlines — are annual, so a shorter window
 * would hide exactly the deadlines a farmer cannot afford to discover late.
 *
 * Both are bounded because every run reads the whole window from both sides.
 * Changing either is safe: the window only ever narrows what deletion may
 * consider, so a widened window adds events and a narrowed one leaves the
 * out-of-range ones in place rather than removing them.
 */
export const PAST_WINDOW_DAYS = 30;
export const FUTURE_WINDOW_DAYS = 365;

/**
 * `configJson` as this usecase reads it.
 *
 * Both fields are written HERE and nowhere else, which is why they are not on
 * `GoogleConfigJson` — `service.ts` has no business knowing about them, the
 * same split `DriveExportConfig` makes for `driveFolderId`.
 */
interface CalendarSyncConfig extends GoogleConfigJson {
    calendarId?: string | null;
    /** The locale the events were rendered in. See the module docblock. */
    calendarLocale?: string | null;
}

export interface CalendarSyncResult {
    calendarId: string;
    /** True when this run made the calendar — first sync, or the farmer deleted it. */
    calendarCreated: boolean;
    created: number;
    updated: number;
    deleted: number;
    /** Already correct — counted so a no-op sync is distinguishable from a failed one. */
    unchanged: number;
    /** Left alone because the farmer had edited them. */
    skippedEdited: number;
    /**
     * True when deletion was SUPPRESSED because the desired set was
     * incomplete — a truncated source read. Surfaced rather than hidden: the
     * calendar may hold an event the farm no longer has, and the caller is
     * entitled to say so instead of reporting a clean sync.
     */
    partial: boolean;
    /** The language the titles were written in. */
    locale: Locale;
}

/** `YYYY-MM-DD` for an offset in days from `now`, in the farm's zone. */
function windowDay(now: Date, offsetDays: number): string {
    const d = new Date(now.getTime() + offsetDays * 86_400_000);
    return dayKeyInTz(d.toISOString(), FARM_TIME_ZONE);
}

export async function syncFarmCalendar(
    ctx: RequestContext,
    deps: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<CalendarSyncResult> {
    // Admin, for `farm-record-drive-export`'s reason: the credential is a
    // tenant-wide secret and `resolveGoogleConnectionToken` already asserts
    // this, so the sync cannot be more open than admin without splitting the
    // resolver. Stated here too so the gate is legible at the top of the
    // usecase rather than reachable only by following a call.
    assertCanAdmin(ctx);
    await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);
    // No module gate, deliberately. The calendar draws on nine sources across
    // several modules and `GET /api/t/{slug}/calendar` gates on none of them;
    // a gate here would refuse a farm whose deadlines it is already serving.

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER, isEnabled: true },
            select: { id: true, configJson: true },
            // Oldest, so the destination is unchanged by connecting a second
            // Google account. See `farm-record-drive-export`.
            orderBy: { createdAt: 'asc' },
        }),
    );
    if (!connection) {
        throw codedBadRequest(
            'GOOGLE_NOT_CONNECTED',
            'No Google account is connected. An administrator connects one in Settings → Integrations.',
        );
    }

    const { accessToken, grantedProducts } = await resolveGoogleConnectionToken(ctx, connection.id);

    // Refuse BEFORE reading nine sources nobody can receive. Google's consent
    // screen lets the scopes be ticked individually, so a connected row with
    // `calendar: false` is an ordinary state rather than a corrupt one.
    if (!grantedProducts.calendar) {
        throw codedBadRequest(
            'GOOGLE_CALENDAR_NOT_GRANTED',
            'The Google connection does not include Calendar access. Reconnect it and grant Calendar.',
        );
    }

    const config = (connection.configJson ?? {}) as unknown as CalendarSyncConfig;
    const calendar = await ensureFarmCalendar(accessToken, config.calendarId ?? null, {
        name: CALENDAR_NAME,
        fetchImpl: deps.fetchImpl,
    });

    // A calendar we just created has no language yet; one we are reusing keeps
    // the language it was written in. Falling back to the caller's own
    // preference only on a fresh calendar is what makes the titles stable.
    const locale: Locale = calendar.created
        ? await callerLocale(ctx)
        : isLocale(config.calendarLocale)
          ? config.calendarLocale
          : await callerLocale(ctx);

    const now = deps.now ?? new Date();
    const fromDay = windowDay(now, -PAST_WINDOW_DAYS);
    const toDay = windowDay(now, FUTURE_WINDOW_DAYS);

    const source = await getCalendarEvents(ctx, {
        from: new Date(`${fromDay}T00:00:00Z`),
        to: new Date(`${toDay}T23:59:59Z`),
        now,
    });

    // The desired set, keyed by the stable composite id `getCalendarEvents`
    // already mints (`TASK:123:task-due`). That id is what rides on the event
    // as `agrentId`, which is why no mapping table is needed.
    const desired = new Map<string, FarmEventContent>();
    for (const ev of source.events) {
        const span = allDaySpan(ev.date, ev.end);
        desired.set(ev.id, {
            // `titleKey` is an i18n key under `calendar.event.*` resolved by
            // the renderer — and there is no renderer here, so the copy is
            // resolved server-side in the calendar's own language. A raw key
            // in a farmer's calendar would read as a bug, which is what
            // shipping the key unresolved would do.
            summary: await translateFor(locale, `calendar.event.${ev.titleKey}`, ev.titleParams),
            startDay: span.startDay,
            endDayExclusive: span.endDayExclusive,
        });
    }

    const existing = await listFarmEvents(accessToken, calendar.calendarId, {
        fetchImpl: deps.fetchImpl,
    });
    const seen = new Set<string>();

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;
    let skippedEdited = 0;

    for (const ev of existing) {
        seen.add(ev.agrentId);
        const want = desired.get(ev.agrentId);

        if (!want) {
            // The two reasons an absence is not evidence. Either one leaves
            // the event in place — a stale event costs a farmer a glance, a
            // wrongly deleted one costs them the deadline.
            const inWindow = ev.startDay >= fromDay && ev.startDay <= toDay;
            if (source.truncated || !inWindow) continue;
            // An edited event is theirs now, not ours to withdraw.
            if (wasEditedByUser(ev)) {
                skippedEdited++;
                continue;
            }
            await deleteFarmEvent(accessToken, calendar.calendarId, ev.eventId, {
                fetchImpl: deps.fetchImpl,
            });
            deleted++;
            continue;
        }

        if (wasEditedByUser(ev)) {
            skippedEdited++;
            continue;
        }
        if (ev.writtenHash === contentFingerprint(want)) {
            unchanged++;
            continue;
        }
        await updateFarmEvent(accessToken, calendar.calendarId, ev.eventId, ev.agrentId, want, {
            fetchImpl: deps.fetchImpl,
        });
        updated++;
    }

    for (const [agrentId, want] of desired) {
        if (seen.has(agrentId)) continue;
        await createFarmEvent(accessToken, calendar.calendarId, agrentId, want, {
            fetchImpl: deps.fetchImpl,
        });
        created++;
    }

    await runInTenantContext(ctx, async (db) => {
        // Written only when something about the destination changed. A write
        // on every sync would say nothing and touch `updatedAt` each run.
        if (calendar.created || config.calendarLocale !== locale) {
            await db.integrationConnection.update({
                where: { id: connection.id },
                data: {
                    configJson: {
                        ...config,
                        calendarId: calendar.calendarId,
                        calendarLocale: locale,
                    } as unknown as Prisma.InputJsonValue,
                },
            });
        }
        // Audited because this sends the farm's schedule out of the platform
        // to an account the platform does not control. The calendar id is the
        // only handle anyone has for asking Google what was written.
        await logEvent(db, ctx, {
            action: 'CALENDAR_SYNCED',
            entityType: 'GoogleCalendarSync',
            entityId: calendar.calendarId,
            // `data_lifecycle` is `.strict()`, so only its four permitted
            // fields go here and the per-operation counts go in `metadata`,
            // which is permissive and sanitised.
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'exported',
                model: 'CalendarEvent',
                recordCount: desired.size,
            },
            metadata: {
                created,
                updated,
                deleted,
                unchanged,
                skippedEdited,
                partial: source.truncated,
                locale,
            },
        });
    });

    return {
        calendarId: calendar.calendarId,
        calendarCreated: calendar.created,
        created,
        updated,
        deleted,
        unchanged,
        skippedEdited,
        partial: source.truncated,
        locale,
    };
}

/**
 * The caller's own language, for a calendar that has none yet.
 *
 * `resolveRecipientLocale` rather than the request cookie, and `bg` rather
 * than `DEFAULT_LOCALE`: these titles go to a known user whose `uiLanguage`
 * column defaults to `bg`, so the unauthenticated English default would be
 * the wrong answer for the farm whose preference merely failed to load.
 */
async function callerLocale(ctx: RequestContext): Promise<Locale> {
    const user = await runInTenantContext(ctx, (db) =>
        db.user.findUnique({ where: { id: ctx.userId }, select: { uiLanguage: true } }),
    );
    return resolveRecipientLocale(user?.uiLanguage);
}

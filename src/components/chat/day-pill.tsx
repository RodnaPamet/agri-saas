'use client';

/**
 * The date separator between days in a conversation — P8.3 (#2797).
 *
 * ## It is a structural device, so it has to encode something true
 *
 * The repo's rule on these: numbering, eyebrows and dividers "should encode
 * something true about the content, not decorate it". A day pill encodes a
 * real boundary — the reader's sense of "that was yesterday" is the thing a
 * timestamp per message does not give them.
 *
 * ## Europe/Sofia, not the browser's zone
 *
 * The boundary is the FARM's day. `dayKeyInTz(date, FARM_TIME_ZONE)` is what
 * decides it, the same helper the journal and the calendar use, because a
 * message at 01:00 Sofia belongs to that date for a Bulgarian farm whatever
 * the device is set to. A browser-local boundary would split one day's
 * conversation across two pills for a reader abroad.
 *
 * ## Today and yesterday are NAMED
 *
 * A reader scanning upward needs to know where "now" is, and a bare date for
 * today reads as history. Anything older gets the date, because
 * «преди 3 дни» stops being useful the moment it competes with a real date
 * further up the thread.
 */
import { useTranslations } from 'next-intl';

import { dayKeyInTz, FARM_TIME_ZONE, farmToday } from '@/lib/calendar-day-key';
import { useDateFormat } from '@/lib/i18n/use-date-format';

export interface DayPillProps {
    /** Any instant on the day being labelled. */
    readonly at: Date;
    /** Injectable for tests; defaults to the real clock. */
    readonly now?: Date;
}

/** The farm-day key for an instant. Exported so the timeline groups identically. */
export function chatDayKey(at: Date): string {
    return dayKeyInTz(at, FARM_TIME_ZONE);
}

export function DayPill({ at, now }: DayPillProps) {
    const t = useTranslations('chat');
    const { formatDate } = useDateFormat();

    const key = chatDayKey(at);
    const today = farmToday(now);
    // Day keys are fixed-width and zero-padded, so string arithmetic on them
    // is calendar arithmetic — the property `calendar-day-key` exists for.
    const yesterday = chatDayKey(new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000));

    const label = key === today ? t('today') : key === yesterday ? t('yesterday') : formatDate(at);

    return (
        <div className="flex justify-center py-tight">
            <span
                // `border-border-subtle` is the default tone: a structural
                // separator, not a discrete surface and not a state.
                className="rounded-full border border-border-subtle bg-bg-default px-3 py-0.5 text-xs text-content-muted"
                // A real date for a screen reader even when the visible label
                // says «Днес» — "today" read aloud a week later is wrong, and
                // the element is cached in the accessibility tree.
                aria-label={formatDate(at)}
            >
                {label}
            </span>
        </div>
    );
}

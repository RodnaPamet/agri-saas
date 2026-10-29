/**
 * The Google Calendar client — #2020.
 *
 * Pure, with a fetch double. Two of these cases pin traps that would have
 * been invisible in review and wrong for most events in production:
 *
 *   - an all-day `end.date` is **exclusive**, so a one-day deadline ends on
 *     the FOLLOWING day. Same-date start and end yields an event Calendar
 *     renders as empty — and single-day deadlines are most of them.
 *   - the day must be computed in **Europe/Sofia**, not sliced off the ISO
 *     instant. A task due at 01:00 Sofia on the 5th is 22:00 UTC on the 4th,
 *     so a slice buckets it onto the previous day. Each of those has a
 *     DISCRIMINATOR case showing the naive answer differs, because a test
 *     that passes under both implementations proves nothing.
 */
import {
    AGRENT_HASH_PROPERTY,
    AGRENT_ID_PROPERTY,
    allDaySpan,
    contentFingerprint,
    createFarmEvent,
    deleteFarmEvent,
    ensureFarmCalendar,
    listFarmEvents,
    updateFarmEvent,
    wasEditedByUser,
} from '@/app-layer/integrations/providers/google/calendar';

function jsonRes(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
}

/** Answers each call in order and records url + init. */
function sequence(steps: Array<Response | Error>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let i = 0;
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        const step = steps[i++];
        if (!step) throw new Error(`unexpected call ${i} to ${String(url)}`);
        if (step instanceof Error) throw step;
        return step;
    }) as unknown as typeof fetch;
    return { impl, calls };
}

const TOK = 'tok';
const CAL = 'cal-1';

describe('all-day spans (#2020)', () => {
    it('ends on the FOLLOWING day, because end.date is exclusive', () => {
        const s = allDaySpan('2026-11-05T00:00:00Z');
        expect(s).toEqual({ startDay: '2026-11-05', endDayExclusive: '2026-11-06' });
    });

    it('DISCRIMINATOR: the naive same-date end would differ', () => {
        // Without this, the case above passes for an implementation that sets
        // end = start, which is the bug it exists to prevent.
        const s = allDaySpan('2026-11-05T00:00:00Z');
        expect(s.endDayExclusive).not.toBe(s.startDay);
    });

    it('computes the day in Europe/Sofia, not from the ISO string', () => {
        // 22:00 UTC on the 4th IS 00:00 Sofia on the 5th. A deadline the farm
        // sees as the 5th must land on the 5th.
        const s = allDaySpan('2026-11-04T22:00:00Z');
        expect(s.startDay).toBe('2026-11-05');
    });

    it('DISCRIMINATOR: slicing the ISO string gives the 4th', () => {
        expect('2026-11-04T22:00:00Z'.slice(0, 10)).toBe('2026-11-04');
    });

    it('handles summer time too, where the offset is +03:00', () => {
        // 21:00 UTC in July is midnight Sofia next day; in November it is not.
        expect(allDaySpan('2026-07-04T21:00:00Z').startDay).toBe('2026-07-05');
        expect(allDaySpan('2026-11-04T21:00:00Z').startDay).toBe('2026-11-04');
    });

    it('spans a duration, exclusive at the end', () => {
        const s = allDaySpan('2026-11-05T00:00:00Z', '2026-11-08T00:00:00Z');
        expect(s).toEqual({ startDay: '2026-11-05', endDayExclusive: '2026-11-09' });
    });

    it('crosses a month and a year boundary by DATE arithmetic, not string', () => {
        // `'2026-11-30' + 1` as a string increment yields `2026-11-31`.
        expect(allDaySpan('2026-11-30T00:00:00Z').endDayExclusive).toBe('2026-12-01');
        expect(allDaySpan('2026-12-31T00:00:00Z').endDayExclusive).toBe('2027-01-01');
        // And a leap day.
        expect(allDaySpan('2028-02-28T00:00:00Z').endDayExclusive).toBe('2028-02-29');
    });
});

describe('the farm calendar (#2020)', () => {
    it('creates one when nothing is stored, in the farm zone', async () => {
        const { impl, calls } = sequence([jsonRes({ id: 'new-cal' })]);
        const r = await ensureFarmCalendar(TOK, null, { name: 'Agrent', fetchImpl: impl });
        expect(r).toEqual({ calendarId: 'new-cal', created: true });
        // One call — no pointless lookup of a null id.
        expect(calls).toHaveLength(1);
        expect(calls[0].init?.method).toBe('POST');
        expect(String(calls[0].init?.body)).toContain('Europe/Sofia');
    });

    it('reuses a stored calendar that still exists', async () => {
        const { impl } = sequence([jsonRes({ id: CAL })]);
        const r = await ensureFarmCalendar(TOK, CAL, { name: 'Agrent', fetchImpl: impl });
        // `created: false` is what stops a configJson write on every sync.
        expect(r).toEqual({ calendarId: CAL, created: false });
    });

    it.each([404, 410])('a %s on the stored id is ORDINARY — the farmer deleted it', async (code) => {
        // Deleting the Agrent calendar is the documented way to revoke this
        // integration, so it must not surface as a fault.
        const { impl } = sequence([jsonRes('gone', code), jsonRes({ id: 'remade' })]);
        const r = await ensureFarmCalendar(TOK, CAL, { name: 'Agrent', fetchImpl: impl });
        expect(r).toEqual({ calendarId: 'remade', created: true });
    });

    it('401 is a revoked grant, not a missing calendar', async () => {
        const { impl } = sequence([jsonRes('Unauthorized', 401)]);
        await expect(
            ensureFarmCalendar(TOK, CAL, { name: 'Agrent', fetchImpl: impl }),
        ).rejects.toMatchObject({ code: 'GOOGLE_GRANT_REVOKED' });
    });

    it('403 about a scope is a missing GRANT', async () => {
        const { impl } = sequence([
            jsonRes({ error: { message: 'Insufficient Permission' } }, 403),
        ]);
        await expect(
            ensureFarmCalendar(TOK, CAL, { name: 'Agrent', fetchImpl: impl }),
        ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_NOT_GRANTED' });
    });

    it('403 about anything else is a REFUSAL, not a missing grant', async () => {
        // Calendar also 403s a rate limit. Telling somebody to reconnect a
        // working connection is wrong advice confidently given — the same
        // distinction `drive.ts` makes for a full Drive.
        const { impl } = sequence([
            jsonRes({ error: { message: 'Rate Limit Exceeded' } }, 403),
        ]);
        await expect(
            ensureFarmCalendar(TOK, CAL, { name: 'Agrent', fetchImpl: impl }),
        ).rejects.toMatchObject({ code: 'GOOGLE_CALENDAR_REFUSED' });
    });

    it('a created calendar with no id is NOT a success', async () => {
        // Proceeding would write the farm's deadlines into the PRIMARY
        // calendar, which is what a separate calendar exists to prevent.
        const { impl } = sequence([jsonRes({ summary: 'Agrent' })]);
        await expect(
            ensureFarmCalendar(TOK, null, { name: 'Agrent', fetchImpl: impl }),
        ).rejects.toThrow(/no id/i);
    });
});

describe('reading back what we wrote (#2020)', () => {
    const ours = (id: string, summary: string, hash?: string) => ({
        id: `g-${id}`,
        summary,
        start: { date: '2026-11-05' },
        end: { date: '2026-11-06' },
        extendedProperties: {
            private: {
                [AGRENT_ID_PROPERTY]: id,
                ...(hash === undefined ? {} : { [AGRENT_HASH_PROPERTY]: hash }),
            },
        },
    });

    it('returns only events carrying our id', async () => {
        // A farmer may keep their own events in this calendar. Those are
        // never touched, so they must not appear here.
        const { impl } = sequence([
            jsonRes({
                items: [
                    ours('TASK:1:task-due', 'Пръскане'),
                    { id: 'theirs', summary: 'Рожден ден', start: { date: '2026-11-05' } },
                ],
            }),
        ]);
        const rows = await listFarmEvents(TOK, CAL, { fetchImpl: impl });
        expect(rows.map((r) => r.agrentId)).toEqual(['TASK:1:task-due']);
    });

    it('PAGINATES, so a second page is not treated as absent', async () => {
        // A single-page read would see the remainder as missing and recreate
        // every one of them as a duplicate.
        const { impl, calls } = sequence([
            jsonRes({ items: [ours('A', 'a')], nextPageToken: 'p2' }),
            jsonRes({ items: [ours('B', 'b')] }),
        ]);
        const rows = await listFarmEvents(TOK, CAL, { fetchImpl: impl });
        expect(rows.map((r) => r.agrentId)).toEqual(['A', 'B']);
        expect(calls[1].url).toContain('pageToken=p2');
    });

    it('computes what the event says NOW, for edit detection', async () => {
        const { impl } = sequence([jsonRes({ items: [ours('A', 'Пръскане')] })]);
        const [row] = await listFarmEvents(TOK, CAL, { fetchImpl: impl });
        expect(row.currentHash).toBe(
            contentFingerprint({
                summary: 'Пръскане',
                startDay: '2026-11-05',
                endDayExclusive: '2026-11-06',
            }),
        );
    });
});

describe('a farmer’s own edit wins (#2020)', () => {
    const base = { eventId: 'g1', agrentId: 'A' };

    it('an untouched event is not an edit', () => {
        expect(wasEditedByUser({ ...base, writtenHash: 'h1', currentHash: 'h1' })).toBe(false);
    });

    it('a changed event IS an edit, and is left alone', () => {
        // They are the person using the calendar. An app that silently
        // reverts a human's change to their own data is worse than one that
        // leaves a deadline slightly stale.
        expect(wasEditedByUser({ ...base, writtenHash: 'h1', currentHash: 'h2' })).toBe(true);
    });

    it('an event written before the fingerprint existed is NOT frozen', () => {
        // Fails towards keeping the calendar correct rather than towards
        // abandoning every pre-fingerprint event forever.
        expect(wasEditedByUser({ ...base, writtenHash: null, currentHash: 'h2' })).toBe(false);
    });

    it('the fingerprint moves with each field we write', () => {
        const a = contentFingerprint({ summary: 's', startDay: '2026-11-05', endDayExclusive: '2026-11-06' });
        const b = contentFingerprint({ summary: 'z', startDay: '2026-11-05', endDayExclusive: '2026-11-06' });
        const c = contentFingerprint({ summary: 's', startDay: '2026-11-06', endDayExclusive: '2026-11-07' });
        expect(new Set([a, b, c]).size).toBe(3);
    });
});

describe('writing and removing events (#2020)', () => {
    it('a create carries our id AND our fingerprint', async () => {
        const { impl, calls } = sequence([jsonRes({ id: 'g-new' })]);
        const id = await createFarmEvent(
            TOK, CAL, 'TASK:1:task-due',
            { summary: 'Пръскане', startDay: '2026-11-05', endDayExclusive: '2026-11-06' },
            { fetchImpl: impl },
        );
        expect(id).toBe('g-new');
        const body = String(calls[0].init?.body);
        expect(body).toContain(AGRENT_ID_PROPERTY);
        expect(body).toContain(AGRENT_HASH_PROPERTY);
        // All-day, not a timed event.
        expect(body).toContain('"date":"2026-11-05"');
        expect(body).not.toContain('dateTime');
    });

    it('a create reporting no id fails the run rather than orphaning', async () => {
        // An event we cannot correlate would be created again next sync.
        const { impl } = sequence([jsonRes({ summary: 'x' })]);
        await expect(
            createFarmEvent(TOK, CAL, 'A', { summary: 's', startDay: 'd', endDayExclusive: 'e' }, { fetchImpl: impl }),
        ).rejects.toThrow(/no id/i);
    });

    it('an update uses PUT, so a stale fingerprint cannot survive', async () => {
        const { impl, calls } = sequence([jsonRes({ id: 'g1' })]);
        await updateFarmEvent(
            TOK, CAL, 'g1', 'A',
            { summary: 'нов', startDay: '2026-11-05', endDayExclusive: '2026-11-06' },
            { fetchImpl: impl },
        );
        expect(calls[0].init?.method).toBe('PUT');
    });

    it.each([404, 410])('a %s on delete is SUCCESS — they deleted it first', async (code) => {
        // Otherwise every sync after a manual tidy-up reports a failure.
        const { impl } = sequence([jsonRes('', code)]);
        await expect(deleteFarmEvent(TOK, CAL, 'g1', { fetchImpl: impl })).resolves.toBeUndefined();
    });

    it('but a 500 on delete is still a failure', async () => {
        const { impl } = sequence([jsonRes('boom', 500)]);
        await expect(deleteFarmEvent(TOK, CAL, 'g1', { fetchImpl: impl })).rejects.toThrow(/500/);
    });

    it('names WHICH call failed on an unexpected status', async () => {
        const { impl } = sequence([jsonRes('boom', 500)]);
        await expect(
            createFarmEvent(TOK, CAL, 'A', { summary: 's', startDay: 'd', endDayExclusive: 'e' }, { fetchImpl: impl }),
        ).rejects.toThrow(/event create failed with 500/);
    });
});

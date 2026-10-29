/**
 * `syncFarmCalendar` — #2020.
 *
 * DB, the gates, audit and the token resolver are doubles, and
 * `getCalendarEvents` is a double because it fans out over nine Prisma
 * sources. The **Calendar client runs for real** against an injected `fetch`:
 * `deps.fetchImpl` threads into `ensureFarmCalendar`, `listFarmEvents` and all
 * three writes, so these cases exercise the actual diff, the exclusive
 * `end.date` and the extended-property round trip rather than a second
 * implementation of them.
 *
 * `translateFor` is NOT mocked. It reads the real message catalogue, which is
 * what makes "the title is resolved copy and not a raw i18n key" a claim about
 * the shipped product rather than about a stub.
 *
 * ## What the deletion cases are really for
 *
 * Three of them assert that NOTHING was deleted. On their own that is a
 * property any never-deleting implementation satisfies, so each is paired with
 * a positive control that DOES delete. The pair is the test; either half alone
 * is green for the wrong reason.
 */
const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
};

const assertCanAdminMock = jest.fn();
const assertFlagMock = jest.fn();
const logEventMock = jest.fn();
const resolveTokenMock = jest.fn();
const getCalendarEventsMock = jest.fn();

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_ctx: unknown, fn: (db: typeof mockDb) => unknown) => fn(mockDb),
}));
jest.mock('@/app-layer/policies/common', () => ({
    __esModule: true,
    assertCanAdmin: (...a: unknown[]) => assertCanAdminMock(...a),
}));
jest.mock('@/lib/feature-flags', () => ({
    __esModule: true,
    assertFeatureEnabled: (...a: unknown[]) => assertFlagMock(...a),
}));
jest.mock('@/app-layer/events/audit', () => ({
    __esModule: true,
    logEvent: (...a: unknown[]) => logEventMock(...a),
}));
jest.mock('@/app-layer/integrations/providers/google/service', () => ({
    __esModule: true,
    GOOGLE_INTEGRATION_FLAG: 'integrations.google',
    resolveGoogleConnectionToken: (...a: unknown[]) => resolveTokenMock(...a),
}));
jest.mock('@/app-layer/usecases/calendar', () => ({
    __esModule: true,
    getCalendarEvents: (...a: unknown[]) => getCalendarEventsMock(...a),
}));

import {
    PAST_WINDOW_DAYS,
    FUTURE_WINDOW_DAYS,
    syncFarmCalendar,
} from '@/app-layer/usecases/calendar-google-sync';
import {
    AGRENT_HASH_PROPERTY,
    AGRENT_ID_PROPERTY,
    allDaySpan,
    contentFingerprint,
} from '@/app-layer/integrations/providers/google/calendar';
import { translateFor } from '@/lib/i18n/server-messages';
import type { RequestContext } from '@/app-layer/types';

const ctx = {
    tenantId: 't1',
    userId: 'u1',
    permissions: { canRead: true, canWrite: true, canAdmin: true },
} as unknown as RequestContext;

const NOW = new Date('2026-11-05T09:00:00Z');
const CAL = 'cal-1';

/** One call the fetch double saw. */
interface Call {
    method: string;
    url: string;
    body: unknown;
}

/**
 * A fetch double that routes by URL shape rather than by call order, because
 * the sync makes a number of calls that depends on the diff.
 */
function router(opts: {
    calendarLookup?: number;
    events?: unknown[];
    pages?: Array<{ items: unknown[]; nextPageToken?: string }>;
}) {
    const calls: Call[] = [];
    const impl = (async (raw: string | URL | Request, init?: RequestInit) => {
        const url = String(raw);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });

        const json = (b: unknown, status = 200) =>
            ({
                ok: status >= 200 && status < 300,
                status,
                json: async () => b,
                text: async () => JSON.stringify(b),
            }) as unknown as Response;

        if (/\/events\/[^/?]+$/.test(url)) return json({ id: 'ok' }); // PUT or DELETE
        if (/\/events(\?|$)/.test(url) && method === 'POST') return json({ id: `g-new-${calls.length}` });
        if (/\/events\?/.test(url)) {
            const pages = opts.pages ?? [{ items: opts.events ?? [] }];
            const token = new URL(url).searchParams.get('pageToken');
            const idx = token ? Number(token) : 0;
            return json(pages[idx] ?? { items: [] });
        }
        if (method === 'POST') return json({ id: CAL }); // calendar create
        return json({ id: CAL }, opts.calendarLookup ?? 200); // calendar lookup
    }) as unknown as typeof fetch;
    return { impl, calls };
}

/** An event as `getCalendarEvents` returns it. */
function srcEvent(id: string, titleKey: string, date: string, name = 'Пръскане') {
    return { id, titleKey, titleParams: { name }, date, status: 'upcoming', category: 'task' };
}

/** The same event as it would already exist in Google, written by us. */
function googleEvent(id: string, content: { summary: string; startDay: string; endDayExclusive: string }, hash?: string) {
    return {
        id: `g-${id}`,
        summary: content.summary,
        start: { date: content.startDay },
        end: { date: content.endDayExclusive },
        extendedProperties: {
            private: {
                [AGRENT_ID_PROPERTY]: id,
                [AGRENT_HASH_PROPERTY]: hash ?? contentFingerprint(content),
            },
        },
    };
}

async function contentFor(titleKey: string, date: string, name = 'Пръскане') {
    const span = allDaySpan(date);
    return {
        summary: await translateFor('bg', `calendar.event.${titleKey}`, { name }),
        startDay: span.startDay,
        endDayExclusive: span.endDayExclusive,
    };
}

function source(events: unknown[], truncated = false) {
    return { events, truncated, counts: { total: events.length }, range: {} };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        id: 'conn-1',
        configJson: { grantedProducts: { drive: false, calendar: true }, grantedScopes: [], calendarId: CAL, calendarLocale: 'bg' },
    });
    mockDb.integrationConnection.update.mockResolvedValue({});
    mockDb.user.findUnique.mockResolvedValue({ uiLanguage: 'bg' });
    resolveTokenMock.mockResolvedValue({
        accessToken: 'tok',
        grantedProducts: { drive: false, calendar: true },
    });
    getCalendarEventsMock.mockResolvedValue(source([]));
});

describe('the gates (#2020)', () => {
    it('refuses without a connection', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        await expect(syncFarmCalendar(ctx)).rejects.toMatchObject({ code: 'GOOGLE_NOT_CONNECTED' });
    });

    it('refuses without the Calendar grant, BEFORE reading any source', async () => {
        // Google's consent screen lets the scopes be ticked individually, so
        // `calendar: false` on a live connection is ordinary. Reading nine
        // Prisma sources for a destination that will refuse them is work
        // nobody can use.
        resolveTokenMock.mockResolvedValue({
            accessToken: 'tok',
            grantedProducts: { drive: true, calendar: false },
        });
        const { impl, calls } = router({});
        await expect(syncFarmCalendar(ctx, { fetchImpl: impl })).rejects.toMatchObject({
            code: 'GOOGLE_CALENDAR_NOT_GRANTED',
        });
        expect(getCalendarEventsMock).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
    });

    it('asserts admin and the flag', async () => {
        const { impl } = router({});
        await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });
        expect(assertCanAdminMock).toHaveBeenCalled();
        expect(assertFlagMock).toHaveBeenCalledWith('integrations.google', 'u1');
    });
});

describe('the desired set becomes events (#2020)', () => {
    it('creates an event per source event, with resolved BULGARIAN copy', async () => {
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-10T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.created).toBe(1);
        const post = calls.find((c) => c.method === 'POST' && /\/events$/.test(c.url));
        const body = post?.body as { summary: string; start: { date: string }; end: { date: string } };
        // The property: resolved copy, not the key. `titleKey` is resolved by
        // the RENDERER everywhere else, and there is no renderer here.
        expect(body.summary).not.toContain('taskDue');
        expect(body.summary).toContain('Краен срок за задача');
        expect(body.summary).toContain('Пръскане');
        // And all-day, with the EXCLUSIVE end.
        expect(body.start.date).toBe('2026-11-10');
        expect(body.end.date).toBe('2026-11-11');
    });

    it('updates an event whose deadline MOVED', async () => {
        // The whole reason this is a sync. A task due date that shifts must
        // move in the calendar, not leave a farmer planning around the old one.
        const stale = await contentFor('taskDue', '2026-11-10T00:00:00Z');
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-20T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [googleEvent('TASK:1:task-due', stale)] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r).toMatchObject({ created: 0, updated: 1, deleted: 0 });
        const put = calls.find((c) => c.method === 'PUT');
        expect((put?.body as { start: { date: string } }).start.date).toBe('2026-11-20');
    });

    it('leaves an already-correct event alone', async () => {
        // The control for the case above. Without it, an implementation that
        // rewrote every event every run would pass it.
        const current = await contentFor('taskDue', '2026-11-20T00:00:00Z');
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-20T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [googleEvent('TASK:1:task-due', current)] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r).toMatchObject({ created: 0, updated: 0, deleted: 0, unchanged: 1 });
        expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
    });
});

describe('absence is not evidence (#2020)', () => {
    /** An event inside the window that the sources no longer want. */
    async function orphanInsideWindow() {
        return googleEvent('TASK:9:task-due', await contentFor('taskDue', '2026-11-10T00:00:00Z'));
    }

    it('POSITIVE CONTROL: an unwanted event INSIDE the window is deleted', async () => {
        // Without this, every "nothing was deleted" case below is satisfied by
        // an implementation that never deletes at all.
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [await orphanInsideWindow()] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.deleted).toBe(1);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    });

    it('deletes NOTHING when the source read was TRUNCATED', async () => {
        // A truncated desired set is incomplete, so every event it dropped
        // looks deleted. `partial` says so rather than reporting a clean sync.
        getCalendarEventsMock.mockResolvedValue(source([], true));
        const { impl, calls } = router({ events: [await orphanInsideWindow()] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.deleted).toBe(0);
        expect(r.partial).toBe(true);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('deletes NOTHING outside the window, so a rolling sync keeps history', async () => {
        // An event that has aged out is absent for a reason that has nothing
        // to do with the farmer. Deleting it would make every run destroy the
        // farm's own record of last season.
        const old = googleEvent('TASK:8:task-due', await contentFor('taskDue', '2020-03-01T00:00:00Z'));
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [old] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.deleted).toBe(0);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('and nothing BEYOND the forward edge either', async () => {
        // The other side of the same bound — a deadline further out than the
        // window reaches was never asked for.
        const far = googleEvent('TASK:7:task-due', await contentFor('taskDue', '2031-03-01T00:00:00Z'));
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [far] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.deleted).toBe(0);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('asks the sources for the window the constants name', async () => {
        // Asserted as DAY bounds rather than a day count: `to` is the end of
        // its day, so a `(to - now) / 86400000` difference rounds to 366 and
        // reads as an off-by-one in the code. The day key is what the window
        // actually means.
        const { impl } = router({});
        await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });
        const arg = getCalendarEventsMock.mock.calls[0][1] as { from: Date; to: Date };
        const shift = (d: number) =>
            new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);
        expect(arg.from.toISOString().slice(0, 10)).toBe(shift(-PAST_WINDOW_DAYS));
        expect(arg.to.toISOString().slice(0, 10)).toBe(shift(FUTURE_WINDOW_DAYS));
    });

    it('the bound it DELETES by is the same one it read by — at the edge', async () => {
        // The arithmetic above says what was asked for; this says the
        // deletion rule applies that same bound. If the two drifted apart,
        // events near an edge would flap in and out between runs.
        const edge = new Date(NOW.getTime() + FUTURE_WINDOW_DAYS * 86_400_000)
            .toISOString()
            .slice(0, 10);
        const atEdge = googleEvent('TASK:6:task-due', {
            summary: 'x',
            startDay: edge,
            endDayExclusive: edge,
        });
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [atEdge] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });
        expect(r.deleted).toBe(1);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    });

    it('and one day PAST the edge is left alone', async () => {
        const past = new Date(NOW.getTime() + (FUTURE_WINDOW_DAYS + 1) * 86_400_000)
            .toISOString()
            .slice(0, 10);
        const beyond = googleEvent('TASK:5:task-due', {
            summary: 'x',
            startDay: past,
            endDayExclusive: past,
        });
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [beyond] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });
        expect(r.deleted).toBe(0);
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });
});

describe('a farmer’s own edit wins (#2020)', () => {
    it('is not overwritten', async () => {
        const theirs = googleEvent(
            'TASK:1:task-due',
            { summary: 'МОЯ бележка', startDay: '2026-11-10', endDayExclusive: '2026-11-11' },
            'a-hash-we-wrote-that-no-longer-matches',
        );
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-20T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [theirs] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r).toMatchObject({ updated: 0, skippedEdited: 1 });
        expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('is not DELETED either, which is the less obvious half', async () => {
        // An edited event has been repurposed. Removing it because the
        // original deadline moved on destroys their work, not ours.
        const theirs = googleEvent(
            'TASK:9:task-due',
            { summary: 'МОЯ бележка', startDay: '2026-11-10', endDayExclusive: '2026-11-11' },
            'a-hash-we-wrote-that-no-longer-matches',
        );
        getCalendarEventsMock.mockResolvedValue(source([]));
        const { impl, calls } = router({ events: [theirs] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r).toMatchObject({ deleted: 0, skippedEdited: 1 });
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    });
});

describe('the calendar and its language persist (#2020)', () => {
    it('stores the calendar id when the calendar was CREATED', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: { grantedProducts: { drive: false, calendar: true }, grantedScopes: [] },
        });
        const { impl } = router({});
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.calendarCreated).toBe(true);
        const data = mockDb.integrationConnection.update.mock.calls[0][0].data as {
            configJson: { calendarId: string; calendarLocale: string; grantedScopes: unknown };
        };
        expect(data.configJson.calendarId).toBe(CAL);
        expect(data.configJson.calendarLocale).toBe('bg');
        // The spread must preserve what `service.ts` owns — a write that
        // replaced `configJson` would drop `grantedProducts` and make the card
        // report an unconnected integration.
        expect(data.configJson).toHaveProperty('grantedProducts');
    });

    it('writes NOTHING when the destination is unchanged', async () => {
        // A write per sync would touch `updatedAt` every run and say nothing.
        const { impl } = router({});
        await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });
        expect(mockDb.integrationConnection.update).not.toHaveBeenCalled();
    });

    it('reuses the STORED locale, so a second admin does not flip every title', async () => {
        // Two admins with different preferences would otherwise rewrite every
        // event on every alternate sync — and the titles would depend on who
        // pressed the button last.
        mockDb.user.findUnique.mockResolvedValue({ uiLanguage: 'en' });
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-10T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.locale).toBe('bg');
        const post = calls.find((c) => c.method === 'POST' && /\/events$/.test(c.url));
        // Asserted on the TEMPLATE, not on a Cyrillic-character regex: the
        // interpolated `{name}` is the farm's own Bulgarian text in either
        // locale, so a character-class check would pass for `en` too and
        // prove nothing about which catalogue was read.
        expect((post?.body as { summary: string }).summary).toContain('Краен срок за задача');
    });

    it('falls back to the CALLER’s language on a fresh calendar', async () => {
        // The control: the stored value wins when there is one, and the caller
        // decides when there is not. Without this the test above passes for an
        // implementation hardcoded to `bg`.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            configJson: { grantedProducts: { drive: false, calendar: true }, grantedScopes: [] },
        });
        mockDb.user.findUnique.mockResolvedValue({ uiLanguage: 'en' });
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-10T00:00:00Z')]),
        );
        const { impl, calls } = router({ events: [] });
        const r = await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        expect(r.locale).toBe('en');
        const post = calls.find((c) => c.method === 'POST' && /\/events$/.test(c.url));
        expect((post?.body as { summary: string }).summary).toContain('Task due');
    });

    it('audits the sync with a structured detail and the counts', async () => {
        getCalendarEventsMock.mockResolvedValue(
            source([srcEvent('TASK:1:task-due', 'taskDue', '2026-11-10T00:00:00Z')]),
        );
        const { impl } = router({ events: [] });
        await syncFarmCalendar(ctx, { fetchImpl: impl, now: NOW });

        const entry = logEventMock.mock.calls[0][2] as {
            action: string;
            detailsJson: Record<string, unknown>;
            metadata: Record<string, unknown>;
        };
        expect(entry.action).toBe('CALENDAR_SYNCED');
        // `data_lifecycle` is `.strict()`, so the counts ride in `metadata`.
        expect(entry.detailsJson).toEqual({
            category: 'data_lifecycle',
            operation: 'exported',
            model: 'CalendarEvent',
            recordCount: 1,
        });
        expect(entry.metadata).toMatchObject({ created: 1, deleted: 0 });
    });
});

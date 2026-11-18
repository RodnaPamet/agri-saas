/**
 * Agro calendar stage 2 — platform-admin overrides of the cited windows
 * (#3095). The read half (merge + mutual exclusivity of `cites` and `basis`)
 * shipped with #3150; this is what writes and clears them, and what feeds
 * them to `GET /api/agro-calendar`.
 *
 * Owner rulings 2026-11-16:
 *   - a window may be CORRECTED (its id exists in the cited dataset) or ADDED
 *     (a new id, for a window МЗХ does not publish);
 *   - corrections take effect at once — no effective date — and clearing one
 *     restores МЗХ's window, clearing an addition removes it;
 *   - an override carries a required `basis` and NO citation, and renders
 *     «Коригирано от Agrent»;
 *   - an added or corrected SOWING window carries a band, exactly as the
 *     loader demands of МЗХ's own.
 *
 * GLOBAL, not per farm: agronomy for North Bulgaria is the same for every farm
 * there. So the write is platform-admin only — through the platform key for
 * scripts, and through the session door gated on `admin.manage` PLUS
 * `assertPlatformSupport` for the phone's console (#2963's two-door pattern):
 * `admin.manage` alone would let an ADMIN of any one farm rewrite every
 * other farm's calendar.
 */
import type { AgroCalendarOverrideOrigin } from '@prisma/client';

import { CALENDAR, calendarCropKeys } from '@/lib/agro/calendar/load';
import { parseOverrideWindow, type LiveOverride, type OverrideWindow } from '@/lib/agro/calendar/overrides';
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import { actorUserIdFor, moderatorRefFor, type ModerationActor } from '@/lib/auth/platform-admin';
import { codedBadRequest, codedNotFound } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { sanitizePlainText } from '@/lib/security/sanitize';

/** The most live overrides a calendar read will merge. Far above any real use. */
const MAX_LIVE_OVERRIDES = 500;

const ORIGIN: Record<AgroCalendarOverrideOrigin, LiveOverride['origin']> = {
    CORRECTED: 'corrected',
    ADDED: 'added',
};

/**
 * Every live override, as the calendar merge takes them.
 *
 * A row whose stored window no longer parses is SKIPPED and logged rather than
 * failing the calendar: the schema can only have moved under it, and one bad
 * correction must not take every farm's calendar down. The cited window it
 * corrected is then served again, which is the safe direction.
 */
export async function loadLiveCalendarOverrides(): Promise<LiveOverride[]> {
    const rows = await prisma.agroCalendarOverride.findMany({
        where: { clearedAt: null },
        orderBy: { createdAt: 'asc' },
        take: MAX_LIVE_OVERRIDES,
        select: { windowId: true, cropKey: true, origin: true, windowJson: true, basisBg: true, basisEn: true },
    });
    const out: LiveOverride[] = [];
    for (const r of rows) {
        const window = parseOverrideWindow(r.windowJson);
        if (!window) {
            logger.error('agro-calendar.override_unreadable', { component: 'agro-calendar', windowId: r.windowId });
            continue;
        }
        out.push({
            windowId: r.windowId,
            cropKey: r.cropKey,
            origin: ORIGIN[r.origin],
            window,
            basis: { bg: r.basisBg, ...(r.basisEn ? { en: r.basisEn } : {}) },
        });
    }
    return out;
}

export interface CalendarOverrideView {
    windowId: string;
    cropKey: string;
    origin: LiveOverride['origin'];
    window: OverrideWindow;
    basis: { bg: string; en?: string };
    /** Who set it: `user:<id>` or `platform-key:<generation>`. */
    authorRef: string;
    setAt: string;
}

/** The live overrides with their author, for the console. */
export async function listCalendarOverrides(): Promise<CalendarOverrideView[]> {
    const rows = await prisma.agroCalendarOverride.findMany({
        where: { clearedAt: null },
        orderBy: { createdAt: 'desc' },
        take: MAX_LIVE_OVERRIDES,
        select: {
            windowId: true, cropKey: true, origin: true, windowJson: true,
            basisBg: true, basisEn: true, authorRef: true, createdAt: true,
        },
    });
    return rows.flatMap((r) => {
        const window = parseOverrideWindow(r.windowJson);
        if (!window) return [];
        return [{
            windowId: r.windowId,
            cropKey: r.cropKey,
            origin: ORIGIN[r.origin],
            window,
            basis: { bg: r.basisBg, ...(r.basisEn ? { en: r.basisEn } : {}) },
            authorRef: r.authorRef,
            setAt: r.createdAt.toISOString(),
        }];
    });
}

export interface SetCalendarOverrideInput {
    cropKey: string;
    /** The window as it should read, without a citation. Its `id` is the window addressed. */
    window: unknown;
    basis: { bg: string; en?: string | null };
}

/**
 * A day that exists in some year: `MM-DD` with a real month and day (29
 * February allowed — the window recurs annually). The calendar schema checks
 * only the SHAPE, which is enough for the hand-checked dataset and not for a
 * date typed into a console: «13-40» has the shape.
 */
function isRealDay(day: string): boolean {
    const [m, d] = day.split('-').map(Number);
    if (!(m >= 1 && m <= 12) || !(d >= 1)) return false;
    return d <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** The crop's cited window with this id, or undefined. */
function publishedWindow(cropKey: string, windowId: string) {
    return CALENDAR.crops.find((c) => c.key === cropKey)?.windows.find((w) => w.id === windowId);
}

/** Every cited window id, across crops — an added id must collide with none. */
function publishedIds(): Set<string> {
    return new Set(CALENDAR.crops.flatMap((c) => c.windows.map((w) => w.id)));
}

/**
 * Correct a cited window, or add one МЗХ does not publish. The origin is
 * DERIVED from the id rather than taken from the caller: an id the dataset
 * carries for that crop is a correction, an id no crop carries is an
 * addition, and an id another crop carries is refused. A caller-chosen origin
 * would let "add" shadow a cited window under the same id.
 *
 * Replaces any live override on the same window — one transaction, so the
 * partial unique index never sees two live rows.
 */
export async function setCalendarOverride(
    input: SetCalendarOverrideInput,
    actor: ModerationActor,
): Promise<CalendarOverrideView> {
    if (!calendarCropKeys().includes(input.cropKey)) {
        throw codedBadRequest('AGRO_CALENDAR_UNKNOWN_CROP', '`cropKey` is not a crop this calendar covers');
    }
    const window = parseOverrideWindow(input.window);
    if (!window || !isRealDay(window.from) || !isRealDay(window.to)) {
        throw codedBadRequest(
            'AGRO_CALENDAR_INVALID_WINDOW',
            'The window does not match the calendar\'s window shape (a citation is never accepted on an override).',
        );
    }
    if (window.kind === 'sowing' && !window.band) {
        // The loader's own rule, held for the override layer too (owner,
        // 2026-11-16): a sowing window without early/optimal/late loses the
        // advice the calendar exists to give.
        throw codedBadRequest('AGRO_CALENDAR_SOWING_NEEDS_BAND', 'A sowing window needs a band: early, optimal or late.');
    }
    const basisBg = sanitizePlainText(input.basis.bg ?? '');
    if (!basisBg) {
        throw codedBadRequest('AGRO_CALENDAR_BASIS_REQUIRED', 'An override needs a basis: why the window differs from the source.');
    }
    const basisEn = input.basis.en ? sanitizePlainText(input.basis.en) || null : null;

    let origin: AgroCalendarOverrideOrigin;
    if (publishedWindow(input.cropKey, window.id)) origin = 'CORRECTED';
    else if (publishedIds().has(window.id)) {
        throw codedBadRequest('AGRO_CALENDAR_WINDOW_OF_ANOTHER_CROP', 'That window id belongs to another crop.');
    } else origin = 'ADDED';

    const authorRef = moderatorRefFor(actor);
    const created = await prisma.$transaction(async (tx) => {
        await tx.agroCalendarOverride.updateMany({
            where: { windowId: window.id, clearedAt: null },
            data: { clearedAt: new Date() },
        });
        return tx.agroCalendarOverride.create({
            data: {
                windowId: window.id,
                cropKey: input.cropKey,
                origin,
                windowJson: window,
                basisBg,
                basisEn,
                authorRef,
            },
            select: { createdAt: true },
        });
    });

    await audit('AGRO_CALENDAR_OVERRIDE_SET', actor, {
        windowId: window.id,
        cropKey: input.cropKey,
        origin,
        from: window.from,
        to: window.to,
        region: window.region,
        ...(window.band ? { band: window.band } : {}),
    });

    return {
        windowId: window.id,
        cropKey: input.cropKey,
        origin: ORIGIN[origin],
        window,
        basis: { bg: basisBg, ...(basisEn ? { en: basisEn } : {}) },
        authorRef,
        setAt: created.createdAt.toISOString(),
    };
}

/**
 * Clear a window's live override: a correction gives МЗХ's window back, an
 * addition disappears. A 404 when nothing is live, so a script cannot read
 * "cleared" for a window that was never overridden.
 */
export async function clearCalendarOverride(windowId: string, actor: ModerationActor): Promise<void> {
    const live = await prisma.agroCalendarOverride.findFirst({
        where: { windowId, clearedAt: null },
        select: { id: true, cropKey: true, origin: true },
    });
    if (!live) throw codedNotFound('AGRO_CALENDAR_OVERRIDE_NOT_FOUND', 'No live override on that window.');
    await prisma.agroCalendarOverride.update({ where: { id: live.id }, data: { clearedAt: new Date() } });
    await audit('AGRO_CALENDAR_OVERRIDE_CLEARED', actor, { windowId, cropKey: live.cropKey, origin: live.origin });
}

/**
 * Into the platform chain, AFTER the write and best-effort — #1619's ruling:
 * an audit subsystem that is sick must not stop a correction, and the gap is
 * logged. The basis text is not copied in; it lives on the row.
 */
async function audit(
    action: 'AGRO_CALENDAR_OVERRIDE_SET' | 'AGRO_CALENDAR_OVERRIDE_CLEARED',
    actor: ModerationActor,
    details: Record<string, unknown>,
): Promise<void> {
    try {
        await appendPlatformAuditEntry({
            scope: 'agro-calendar',
            action,
            actorUserId: actorUserIdFor(actor),
            detailsJson: { ...details, authorRef: moderatorRefFor(actor) },
        });
    } catch (err) {
        logger.error('agro-calendar.audit_append_failed', {
            component: 'agro-calendar',
            action,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

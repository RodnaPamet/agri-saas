/**
 * Agro-intel in-app notifications — spray-window warnings + disease-risk
 * escalations fired by the daily `weather-pull` job's signal evaluator.
 *
 * Modelled exactly on `createAssignmentNotification` (assignment.ts):
 *   - `db.notification.createMany({ skipDuplicates: true })` so a
 *     duplicate dedupeKey returns count=0 with NO exception (raw
 *     `create` throws P2002 which poisons interactive PG transactions).
 *   - dedupeKey shape `{tenantId}:{TYPE}:{entityId}:{userId}:{date}` so
 *     the same location/recipient/day collapses to one bell row —
 *     a second backstop beneath the AgroSignal unique key.
 *
 * These use the existing `GENERAL` NotificationType rather than minting
 * new enum values: the row's title/message carry the agro semantics and
 * the link drops the recipient on the location's detail page. Keeping to
 * `GENERAL` means no schema migration is needed for the notification
 * surface.
 *
 * Fire-and-forget — callers isolate the write in its own transaction so
 * a notification failure never rolls back the signal/Risk write.
 */

import type { PrismaClient } from '@prisma/client';
import { translateFor } from '@/lib/i18n/server-messages';
import type { Locale } from '@/lib/i18n/locales';
import { publishFreshNotifications } from './publish-fresh';

export type AgroNotificationKind = 'SPRAY_WINDOW_WARNING' | 'DISEASE_RISK_RAISED' | 'AGRO_COPILOT_READY';

export interface AgroNotificationTarget {
    tenantId: string;
    /** Recipient — the location owner, or the job's admin fallback. */
    recipientUserId: string;
    /** Location the signal is for — also the deep-link target + dedupe entity. */
    locationId: string;
    /** Display label (location name). */
    locationLabel: string;
    /** Tenant slug for the deep link. */
    tenantSlug: string;
    /**
     * Short reason summary for the notification body — ALREADY in
     * `locale` (#2490).
     *
     * The caller renders it, because the caller is what holds the
     * structured reason: `evaluateSprayWindow` / `evaluateDiseaseRisk`
     * return `reasonCodes`, and `@/lib/agro/reason-label` turns one into
     * a sentence. Passing the English `reasons[0]` here puts an English
     * clause inside a Bulgarian sentence, which is what this issue was.
     */
    detail?: string | null;
    /**
     * The RECIPIENT's language. Required, not defaulted — the row stores
     * RENDERED text, so a forgotten locale is indistinguishable from a
     * chosen one and would silently ship the wrong language. Same rule as
     * `EnqueueEmailInput.locale`; resolve it with `resolveRecipientLocale`.
     */
    locale: Locale;
}

/**
 * Catalogue keys, not sentences (#2490).
 *
 * These three titles were English string literals and the bodies were
 * English template functions, so every bell row and every Web Push on the
 * agro surface arrived in English — in a product whose `User.uiLanguage`
 * column defaults to `bg` and four of whose five users carry it.
 *
 * TWO body keys rather than one with a conditional, because `translateFor`
 * is a plain `interpolate` with NO ICU support: a `{detail, select, ...}`
 * would come back as the literal template, and the i18n drift check would
 * read its inner words as placeholder names. The same reason the digest
 * reasons and the task-due copy are shaped this way.
 */
interface AgroCopy {
    titleKey: string;
    bodyKey: string;
    bodyWithDetailKey: string;
    /**
     * The PUSH body — #1999. Takes NO parameters, deliberately.
     *
     * `bodyKey` and `bodyWithDetailKey` both interpolate `{label}`, which is
     * the LOCATION NAME the farmer chose («блок 3 до реката»). That is right
     * for the bell and the web UI and wrong for an APNs alert, which Apple can
     * read — so the push body names no block.
     *
     * Unlike the assignment notifications, there is no identifier to keep: a
     * Location has no user-facing key the way a Task has `T-123`. The deep
     * link carries the location id, so tapping the notification still lands on
     * the right block; the cost is that a farm with several blocks cannot tell
     * which one from the lock screen. Owner ruling 2026-11-01.
     *
     * Every kind has one even though only SPRAY_WINDOW_WARNING is pushed
     * today, because the alternative is a kind whose push body resolves to the
     * empty string — and an empty body is indistinguishable from a deliberate
     * title-only alert, so the next producer to push `DISEASE_RISK` would ship
     * a blank notification and no test would notice.
     */
    pushBodyKey: string;
}

const COPY: Record<AgroNotificationKind, AgroCopy> = {
    SPRAY_WINDOW_WARNING: {
        titleKey: 'notifications.agro.sprayWindow.title',
        bodyKey: 'notifications.agro.sprayWindow.body',
        bodyWithDetailKey: 'notifications.agro.sprayWindow.bodyWithDetail',
        pushBodyKey: 'notifications.agro.sprayWindow.pushBody',
    },
    DISEASE_RISK_RAISED: {
        titleKey: 'notifications.agro.diseaseRisk.title',
        bodyKey: 'notifications.agro.diseaseRisk.body',
        bodyWithDetailKey: 'notifications.agro.diseaseRisk.bodyWithDetail',
        pushBodyKey: 'notifications.agro.diseaseRisk.pushBody',
    },
    AGRO_COPILOT_READY: {
        titleKey: 'notifications.agro.copilot.title',
        bodyKey: 'notifications.agro.copilot.body',
        bodyWithDetailKey: 'notifications.agro.copilot.bodyWithDetail',
        pushBodyKey: 'notifications.agro.copilot.pushBody',
    },
};

/**
 * Every catalogue key this module can resolve, DERIVED from the table above.
 *
 * Exported so the completeness check reads the real table rather than
 * restating it — a second copy is how a fourth notification kind ends up
 * shipping its key as a push title, since `translateFor` returns the key on
 * a miss and throws nothing.
 */
export const AGRO_COPY_KEYS: readonly string[] = Object.values(COPY).flatMap((c) => [
    c.titleKey,
    c.bodyKey,
    c.bodyWithDetailKey,
]);

/**
 * Build the idempotency key. Pure helper so tests can assert the format.
 * Day granularity in UTC — a same-day re-run shouldn't double-notify.
 */
export function buildAgroDedupeKey(
    tenantId: string,
    kind: AgroNotificationKind,
    locationId: string,
    userId: string,
    now: Date = new Date(),
): string {
    const ymd = now.toISOString().slice(0, 10);
    return `${tenantId}:${kind}:${locationId}:${userId}:${ymd}`;
}

export interface AgroNotificationOutcome {
    status: 'created' | 'duplicate';
    /** Notification copy, present only when `status === 'created'`. */
    notification?: {
        title: string;
        /** For the bell and the web UI — names the location. */
        message: string;
        /** For a PUSH payload — names no location (#1999). */
        pushBody: string;
        linkUrl: string;
    };
}

export async function createAgroSignalNotification(
    db: Pick<PrismaClient, 'notification'>,
    kind: AgroNotificationKind,
    target: AgroNotificationTarget,
    now: Date = new Date(),
): Promise<AgroNotificationOutcome> {
    const copy = COPY[kind];
    const detail = target.detail?.trim() || null;
    const title = await translateFor(target.locale, copy.titleKey);
    const message = detail
        ? await translateFor(target.locale, copy.bodyWithDetailKey, {
              label: target.locationLabel,
              detail,
          })
        : await translateFor(target.locale, copy.bodyKey, { label: target.locationLabel });
    const dedupeKey = buildAgroDedupeKey(
        target.tenantId,
        kind,
        target.locationId,
        target.recipientUserId,
        now,
    );
    const row = {
        tenantId: target.tenantId,
        userId: target.recipientUserId,
        // Reuse GENERAL — no enum migration; semantics ride the title/body.
        type: 'GENERAL' as const,
        title,
        message,
        linkUrl: `/t/${target.tenantSlug}/locations/${target.locationId}`,
        dedupeKey,
    };

    const result = await db.notification.createMany({
        data: [row],
        skipDuplicates: true,
    });

    if (result.count > 0) {
        await publishFreshNotifications(db, 'notify.agro', [
            { tenantId: target.tenantId, userId: target.recipientUserId, dedupeKey: row.dedupeKey },
        ]);
    }

    return result.count > 0
        ? {
              status: 'created',
              notification: {
                  title: row.title,
                  message: row.message,
                  pushBody: await translateFor(target.locale, copy.pushBodyKey),
                  linkUrl: row.linkUrl,
              },
          }
        : { status: 'duplicate' };
}

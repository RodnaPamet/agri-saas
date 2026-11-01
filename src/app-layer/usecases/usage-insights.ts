import prisma from '@/lib/prisma';
import { USAGE_EVENT_RETENTION_DAYS } from '@/app-layer/telemetry/usage-events';

/**
 * The superuser's read of product usage — #493.
 *
 * Owner, 2026-11-01: *"our server, per account"*, with a view **per farm and
 * per screen**. This is that view's data.
 *
 * ## Why this one is cross-tenant, and why that is not a loophole
 *
 * Every other read in this codebase is confined to one farm. This one is a
 * PLATFORM question — "which screens are used, across the product" — asked by a
 * superuser holding the platform admin credential, and there is no tenant
 * context that could serve it: a per-tenant loop would need a tenant list, take
 * a connection per tenant, and silently omit any farm the loop forgot.
 *
 * So it uses the global client deliberately, which is why it carries an entry
 * in `no-direct-prisma`'s allowlist. What stands in for tenant scoping is the
 * CALLER: the page is gated on `isPlatformTenant` plus `canAdmin`, the same
 * gate as `/admin/market-prices` and `/admin/promotions`, and it returns
 * aggregates rather than rows.
 *
 * ## It counts, it does not reconstruct
 *
 * Deliberately no per-user timeline and no event list. A superuser answering
 * "is anybody using «Тенденции»" needs counts; the same table could answer
 * "what did this named person do on Tuesday", and that is a different product
 * with a different justification. The aggregate shape is the control: there is
 * no endpoint that returns a person's events in order.
 *
 * `distinctUsers` is a COUNT, never a list of ids.
 */

export interface UsageByFarm {
    tenantId: string;
    tenantName: string;
    events: number;
    distinctUsers: number;
    lastSeen: Date;
}

export interface UsageByName {
    name: string;
    surface: string | null;
    events: number;
    distinctUsers: number;
}

export interface UsageInsights {
    /** The window these figures cover, in days. */
    days: number;
    totalEvents: number;
    byFarm: UsageByFarm[];
    /** `screen_opened` split by surface — the "per screen" half of the ask. */
    byScreen: UsageByName[];
    /** Every other name. */
    byAction: UsageByName[];
}

/**
 * Clamp the window to the retention period.
 *
 * Asking for 365 days would silently report 90 days of data under a 365-day
 * heading, which is the kind of quiet wrongness that makes somebody conclude
 * usage collapsed last spring. The clamp is returned in `days` so the page can
 * say what it actually covered.
 */
function clampDays(requested: number): number {
    if (!Number.isFinite(requested) || requested < 1) return 30;
    return Math.min(Math.floor(requested), USAGE_EVENT_RETENTION_DAYS);
}

export async function getUsageInsights(opts: { days?: number } = {}): Promise<UsageInsights> {
    const days = clampDays(opts.days ?? 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // `receivedAt`, never `at`: the client clock is advisory, and a window built
    // on it would include or omit rows according to how wrong a phone was.
    const [byFarm, byName, total] = await Promise.all([
        prisma.$queryRaw<
            { tenantId: string; tenantName: string; events: bigint; distinctUsers: bigint; lastSeen: Date }[]
        >`
            SELECT u."tenantId",
                   t."name"                        AS "tenantName",
                   COUNT(*)                        AS "events",
                   COUNT(DISTINCT u."userId")      AS "distinctUsers",
                   MAX(u."receivedAt")             AS "lastSeen"
            FROM "UsageEvent" u
            JOIN "Tenant" t ON t."id" = u."tenantId"
            WHERE u."receivedAt" >= ${since}
            GROUP BY u."tenantId", t."name"
            ORDER BY COUNT(*) DESC
        `,
        prisma.$queryRaw<
            { name: string; surface: string | null; events: bigint; distinctUsers: bigint }[]
        >`
            SELECT "name", "surface",
                   COUNT(*)                   AS "events",
                   COUNT(DISTINCT "userId")   AS "distinctUsers"
            FROM "UsageEvent"
            WHERE "receivedAt" >= ${since}
            GROUP BY "name", "surface"
            ORDER BY COUNT(*) DESC
        `,
        prisma.usageEvent.count({ where: { receivedAt: { gte: since } } }),
    ]);

    const n = (v: bigint) => Number(v);
    const rows = byName.map((r) => ({ ...r, events: n(r.events), distinctUsers: n(r.distinctUsers) }));

    return {
        days,
        totalEvents: total,
        byFarm: byFarm.map((r) => ({ ...r, events: n(r.events), distinctUsers: n(r.distinctUsers) })),
        byScreen: rows.filter((r) => r.name === 'screen_opened'),
        byAction: rows.filter((r) => r.name !== 'screen_opened'),
    };
}

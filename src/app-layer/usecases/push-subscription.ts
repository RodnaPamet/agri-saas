import type { ApnsEnvironment } from '@prisma/client';
/**
 * Push-registration usecase — a tenant member managing their OWN devices
 * (self-service, like MFA enrolment).
 *
 * Two transports since #1764: one row per (tenant, user, browser endpoint) for
 * Web Push, and one per (tenant, user, device token) for APNs. The row carries
 * a `platform` discriminator and the database enforces each shape with a CHECK
 * — see `prisma/migrations/20261014060000_push_subscription_platform`.
 *
 * Re-registering the same device is idempotent on both transports, which
 * matters more for APNs than for Web Push: iOS hands the app a token on every
 * launch, so a non-idempotent write would accumulate a row per launch.
 */
import { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';

export interface SavePushSubscriptionInput {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
}

export async function savePushSubscription(
    ctx: RequestContext,
    input: SavePushSubscriptionInput,
): Promise<{ id: string }> {
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.pushSubscription.findFirst({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, endpoint: input.endpoint },
            select: { id: true },
        });
        if (existing) {
            await db.pushSubscription.update({
                where: { id: existing.id },
                data: { p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null },
            });
            return { id: existing.id };
        }
        return db.pushSubscription.create({
            data: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                endpoint: input.endpoint,
                p256dh: input.p256dh,
                auth: input.auth,
                userAgent: input.userAgent ?? null,
            },
            select: { id: true },
        });
    });
}

export async function removePushSubscription(ctx: RequestContext, endpoint: string): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.pushSubscription.deleteMany({
            where: { tenantId: ctx.tenantId, userId: ctx.userId, endpoint },
        }),
    );
}

/**
 * Wire form → column enum, declared once — #1764 step 3.
 *
 * A `Record` of the schema's literal union rather than `toUpperCase()`: the
 * cast version compiles for any string and would put `"SANDBOX"` in the column
 * the day somebody widens the wire values without looking here. This fails to
 * compile instead.
 */
const APNS_ENVIRONMENT_BY_WIRE = {
    development: 'DEVELOPMENT',
    production: 'PRODUCTION',
} as const satisfies Record<'development' | 'production', ApnsEnvironment>;

/**
 * Register THIS phone for APNs (#1764).
 *
 * Idempotent on `[tenantId, userId, deviceToken]`, which the partial unique
 * index `PushSubscription_ios_identity` also enforces. iOS delivers a token to
 * the app on every launch and after every restore, so the common call is a
 * re-registration of a token already stored — a create-only path would grow a
 * row per launch until the index refused, and then fail the launch.
 *
 * The three Web Push columns are left NULL, which
 * `PushSubscription_ios_shape` requires: a row carrying both transports'
 * fields would make the deliverer's per-row dispatch ambiguous.
 */
export async function saveApnsRegistration(
    ctx: RequestContext,
    input: {
        deviceToken: string;
        userAgent?: string | null;
        /** Lower-case wire form; mapped to the `ApnsEnvironment` enum here. */
        environment?: 'development' | 'production';
    },
): Promise<{ id: string }> {
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.pushSubscription.findFirst({
            where: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                platform: 'IOS',
                deviceToken: input.deviceToken,
            },
            select: { id: true },
        });
        if (existing) {
            // ── the widened update — #1764 step 3 ──
            //
            // This path used to write `userAgent` and nothing else, which made
            // a re-registration a no-op for every other column. That is the
            // defect agrent-ios identified: a row created before
            // `apnsEnvironment` existed would keep it NULL for ever, the
            // sender would refuse the row, and the phone would silently
            // receive nothing while appearing registered. The phone
            // re-registers on every signed-in launch, so this is the one place
            // that can correct a stored value.
            //
            // Only what the caller SENT is written. An absent field leaves the
            // stored value alone rather than nulling it, which matters in both
            // directions: an older build that does not send `environment` must
            // not erase a value a newer build stored, and the same reasoning
            // applies to `userAgent`. That is the `!== undefined` convention
            // the rest of this codebase uses for partial updates — see
            // `updateFarmBrand`.
            //
            // It also fixes a smaller pre-existing version of the same bug:
            // `userAgent: input.userAgent ?? null` erased a stored agent
            // whenever a caller omitted one.
            const data: Record<string, unknown> = {};
            if (input.userAgent !== undefined) data.userAgent = input.userAgent;
            if (input.environment !== undefined) {
                data.apnsEnvironment = APNS_ENVIRONMENT_BY_WIRE[input.environment];
            }
            if (Object.keys(data).length > 0) {
                await db.pushSubscription.update({ where: { id: existing.id }, data });
            }
            return { id: existing.id };
        }
        return db.pushSubscription.create({
            data: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                platform: 'IOS',
                deviceToken: input.deviceToken,
                userAgent: input.userAgent ?? null,
                apnsEnvironment: input.environment
                    ? APNS_ENVIRONMENT_BY_WIRE[input.environment]
                    : null,
            },
            select: { id: true },
        });
    });
}

/**
 * Unregister a phone.
 *
 * Scoped to the caller's own rows and to `platform: 'IOS'`. The platform
 * filter is not redundant: a device token and an endpoint can never collide in
 * practice, but a delete that matched on token alone would be one schema
 * change away from reaching a row of the other transport, and the cost of
 * being wrong here is somebody's notifications stopping silently.
 */
export async function removeApnsRegistration(
    ctx: RequestContext,
    deviceToken: string,
): Promise<void> {
    await runInTenantContext(ctx, (db) =>
        db.pushSubscription.deleteMany({
            where: {
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                platform: 'IOS',
                deviceToken,
            },
        }),
    );
}

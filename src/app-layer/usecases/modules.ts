import { RequestContext } from '../types';
import { ModuleSettingsRepository } from '../repositories/ModuleSettingsRepository';
import { assertCanRead, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { codedForbidden, forbidden, badRequest } from '@/lib/errors/types';
import { isAllowedMeteobotUrl } from '@/lib/security/meteobot';
import { runInTenantContext } from '@/lib/db-context';
import { ModuleKey } from '@prisma/client';
import { ALL_MODULES, resolveEnabledModules, coerceModuleKeys } from '@/lib/modules';
import { getTenantPlan } from '@/lib/entitlements-server';
import { planAllowsModule, planModules } from '@/lib/entitlements';
import { recordModuleAccess } from '@/lib/observability/module-metrics';

/**
 * Per-tenant module gating. A module is AVAILABLE when
 * `(plan allows) ∧ (tenant enabled)`:
 *   - the PLAN half is the billing ceiling (`@/lib/entitlements`
 *     MODULE_MIN_PLAN); a `null` plan (self-hosted / unconfigured) allows
 *     everything, so on-prem + dev are unaffected.
 *   - the TENANT half is `TenantModuleSettings.enabledModules` (a fresh
 *     tenant has every module enabled).
 * `assertModuleEnabled` (API) + `requireModule` (page redirect) both gate
 * on AVAILABILITY, mirroring `assertCanWrite`.
 */

/** The tenant's effective enabled-module list (default = all). */
export async function getEnabledModules(ctx: RequestContext): Promise<ModuleKey[]> {
    return runInTenantContext(ctx, async (db) => resolveEnabledModules(await ModuleSettingsRepository.get(db, ctx)));
}

/** Admin read of the module settings (+ whether the tenant has customised). */
export async function getModuleSettings(ctx: RequestContext) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const row = await ModuleSettingsRepository.get(db, ctx);
        return {
            enabledModules: resolveEnabledModules(row),
            customized: Boolean(row),
            allModules: [...ALL_MODULES],
        };
    });
}

/** Admin write — replace the tenant's enabled-module list. */
export async function setEnabledModules(ctx: RequestContext, enabledModules: ModuleKey[]) {
    assertCanAdmin(ctx);
    // Defence-in-depth: drop unknown keys + dedupe (the route's Zod enum
    // is the first gate; this keeps a non-HTTP caller from persisting
    // garbage or duplicate-bloated arrays into the enum[] column).
    const normalized = [...new Set(coerceModuleKeys(enabledModules))];
    return runInTenantContext(ctx, async (db) => {
        const row = await ModuleSettingsRepository.upsert(db, ctx, normalized);
        await logEvent(db, ctx, {
            action: 'TENANT_MODULES_UPDATED',
            entityType: 'TenantModuleSettings',
            entityId: row.id,
            details: `Enabled modules set to: ${normalized.join(', ') || '(none)'}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantModuleSettings',
                operation: 'updated',
                after: { enabledModules: normalized },
                summary: 'Tenant modules updated',
            },
        });
        return { enabledModules: row.enabledModules };
    });
}

/** Read the tenant's Meteobot station URL (#14) — null when unset. */
export async function getMeteobotStationUrl(ctx: RequestContext): Promise<string | null> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const row = await ModuleSettingsRepository.get(db, ctx);
        return row?.meteobotStationUrl ?? null;
    });
}

/**
 * Set (or clear) the tenant's Meteobot station URL (#14). ADMIN-gated. A
 * non-empty URL must be an https link on an allowed Meteobot host — the SAME
 * allowlist the CSP `frame-src` uses (see `@/lib/security/meteobot`), so we
 * never persist a URL the browser would then refuse to frame. Clearing
 * (null/empty) is always allowed.
 */
export async function setMeteobotStationUrl(ctx: RequestContext, url: string | null) {
    assertCanAdmin(ctx);
    const trimmed = url && url.trim().length > 0 ? url.trim() : null;
    if (trimmed !== null && !isAllowedMeteobotUrl(trimmed)) {
        throw badRequest('The station URL must be an https link on a meteobot.com domain.');
    }
    return runInTenantContext(ctx, async (db) => {
        const row = await ModuleSettingsRepository.setMeteobotUrl(db, ctx, trimmed);
        await logEvent(db, ctx, {
            action: 'TENANT_MODULES_UPDATED',
            entityType: 'TenantModuleSettings',
            entityId: row.id,
            details: trimmed ? 'Meteobot station URL set' : 'Meteobot station URL cleared',
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'TenantModuleSettings',
                operation: 'updated',
                summary: 'Meteobot station URL updated',
            },
        });
        return { meteobotStationUrl: row.meteobotStationUrl };
    });
}

export async function isModuleEnabled(ctx: RequestContext, key: ModuleKey): Promise<boolean> {
    return (await getEnabledModules(ctx)).includes(key);
}

/**
 * Modules AVAILABLE to the tenant = (plan allows) ∩ (tenant enabled).
 * The plan half resolves via `@/lib/entitlements`; a `null` plan
 * (billing unconfigured / self-hosted) allows every module, so the
 * tenant flag is the only gate in that mode.
 */
export async function getAvailableModules(ctx: RequestContext): Promise<ModuleKey[]> {
    const [plan, enabled] = await Promise.all([
        getTenantPlan(ctx.tenantId),
        getEnabledModules(ctx),
    ]);
    const allowed = new Set(planModules(plan));
    return enabled.filter((k) => allowed.has(k));
}

export async function isModuleAvailable(ctx: RequestContext, key: ModuleKey): Promise<boolean> {
    const plan = await getTenantPlan(ctx.tenantId);
    if (!planAllowsModule(plan, key)) return false;
    return isModuleEnabled(ctx, key);
}

/**
 * Throw `MODULE_DISABLED` if `key` is not AVAILABLE (plan-allowed ∧
 * tenant-enabled). Call after `getTenantCtx` in any API route belonging to a
 * gated module. The page twin is `requireModule()` (redirect) in
 * `@/lib/security/require-module`.
 *
 * ## `params.reason` — because the two halves have different remedies
 *
 * AVAILABLE is a conjunction, and which side failed decides what a client may
 * truthfully tell the person:
 *
 *   `reason: 'tenant'`   an administrator of THIS farm can turn it on.
 *   `reason: 'plan'`     the plan does not include it. No administrator can
 *                        turn it on, and on iOS nobody can be sent anywhere
 *                        (App Store 3.1.1).
 *
 * Collapsed into one answer, this is the agrent-ios#241 shape: a farmer sent
 * to an admin who cannot help. It nearly shipped as exactly that — #1679's
 * first spec text said "an administrator of the farm can turn it on" full
 * stop, and agrent-ios had already written that sentence into Bulgarian from
 * it before reading the conjunction here and catching it.
 *
 * A PARAM rather than a second code (`MODULE_NOT_IN_PLAN`), deliberately:
 * `MODULE_DISABLED` currently means "this module is off", which is true of
 * both halves, and splitting it would NARROW an already-published code — a
 * breaking change for any client switching on it. A param is additive, so a
 * client that ignores it keeps a correct, neutral sentence.
 *
 * The two checks are the two reads `isModuleAvailable` already performs, in
 * the same order, so this costs no extra query.
 */
export async function assertModuleEnabled(ctx: RequestContext, key: ModuleKey): Promise<void> {
    // Usage telemetry (module × device) — recorded before the check so denied
    // attempts count too. Best-effort; never affects the gate.
    await recordModuleAccess(key);

    const plan = await getTenantPlan(ctx.tenantId);
    if (!planAllowsModule(plan, key)) {
        throw codedForbidden('MODULE_DISABLED', `module ${key} is not available`, {
            module: key,
            reason: 'plan',
        });
    }
    if (!(await isModuleEnabled(ctx, key))) {
        throw codedForbidden('MODULE_DISABLED', `module ${key} is not available`, {
            module: key,
            reason: 'tenant',
        });
    }
}

/**
 * Google Earth Engine credential presence — the LIGHT half of the GEE seam.
 *
 * `earth-engine.ts` imports the heavy `@google/earthengine` client (it is
 * `serverExternalPackages`-listed so it never reaches the browser bundle), so
 * anything that only needs to know "are we configured?" must not import it:
 * a server page shell, a health probe, or a startup hook would drag the whole
 * EE client in for a two-field boolean.
 *
 * This module holds that predicate on its own — env reads only, no EE import.
 * `earth-engine.ts` re-exports {@link isGeeConfigured} so existing callers (and
 * the route unit tests that mock `@/lib/agro/earth-engine`) are unchanged.
 *
 * @module lib/agro/gee-config
 */
import { env } from '@/env';

/**
 * True only when BOTH the project id and the service-account key are set.
 * When false every satellite surface degrades honestly: the index tile routes
 * report `configured:false`, per-parcel analysis returns null readings, and the
 * field briefing runs without satellite input.
 */
export function isGeeConfigured(): boolean {
    return Boolean(env.GEE_PROJECT_ID && env.GEE_SERVICE_ACCOUNT_KEY);
}

/** The individual GEE keys, for the operator-facing "why is satellite off" signal. */
export interface GeeConfigStatus {
    configured: boolean;
    /** Names of the GEE env vars that are absent — empty when configured. */
    missing: string[];
}

/**
 * Which GEE env vars are missing. Used by the startup hook + `/api/readyz`
 * to make "satellite is off" OBSERVABLE to operators without failing the
 * process or the probe — the product degrades honestly by design, so a
 * missing key is a capability signal, not an outage.
 */
export function geeConfigStatus(): GeeConfigStatus {
    const missing: string[] = [];
    if (!env.GEE_PROJECT_ID) missing.push('GEE_PROJECT_ID');
    if (!env.GEE_SERVICE_ACCOUNT_KEY) missing.push('GEE_SERVICE_ACCOUNT_KEY');
    return { configured: missing.length === 0, missing };
}

/**
 * Plan Entitlements
 *
 * Single source of truth for which features are available on each billing plan.
 * Used by both server-side gates (API routes) and client-side UI (UpgradeGate component).
 *
 * ─── Feature-to-Plan Mapping ───
 *
 * | Feature                  | FREE | TRIAL | PRO | ENTERPRISE |
 * |--------------------------|------|-------|-----|------------|
 * | PDF_EXPORTS              | ✗    | ✓     | ✓   | ✓          |
 * | AUDIT_PACK_SHARING       | ✗    | ✗     | ✓   | ✓          |
 * | ADVANCED_VENDOR_MGMT     | ✗    | ✗     | ✓   | ✓          |
 * | CUSTOM_INTEGRATIONS      | ✗    | ✗     | ✗   | ✓          |
 */
import type { ModuleKey } from '@prisma/client';

/** Billing plan enum — mirrors Prisma BillingPlan but defined locally to avoid generated-client import issues. */
type BillingPlan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';

// ─── Feature Keys ───

export const FEATURES = {
    PDF_EXPORTS: 'PDF_EXPORTS',
    AUDIT_PACK_SHARING: 'AUDIT_PACK_SHARING',
    ADVANCED_VENDOR_MGMT: 'ADVANCED_VENDOR_MGMT',
    CUSTOM_INTEGRATIONS: 'CUSTOM_INTEGRATIONS',
} as const;

export type FeatureKey = (typeof FEATURES)[keyof typeof FEATURES];

// ─── Plan hierarchy for comparisons ───

const PLAN_LEVEL: Record<BillingPlan, number> = {
    FREE: 0,
    TRIAL: 1,
    PRO: 2,
    ENTERPRISE: 3,
};

// ─── Feature → minimum plan required ───

const FEATURE_MIN_PLAN: Record<FeatureKey, BillingPlan> = {
    PDF_EXPORTS: 'TRIAL',
    AUDIT_PACK_SHARING: 'PRO',
    ADVANCED_VENDOR_MGMT: 'PRO',
    CUSTOM_INTEGRATIONS: 'ENTERPRISE',
};

// ─── Feature labels for UI ───

export const FEATURE_LABELS: Record<FeatureKey, string> = {
    PDF_EXPORTS: 'PDF Exports',
    AUDIT_PACK_SHARING: 'Audit Pack Sharing',
    ADVANCED_VENDOR_MGMT: 'Advanced Vendor Management',
    CUSTOM_INTEGRATIONS: 'Custom Integrations',
};

// ─── Core check ───

/**
 * Check if a plan includes a given feature.
 * Pure function — no DB access.
 */
export function hasFeature(plan: BillingPlan | string, feature: FeatureKey): boolean {
    const currentLevel = PLAN_LEVEL[plan as BillingPlan] ?? 0;
    const requiredPlan = FEATURE_MIN_PLAN[feature];
    const requiredLevel = PLAN_LEVEL[requiredPlan] ?? 0;
    return currentLevel >= requiredLevel;
}

/**
 * Get the minimum plan required for a feature.
 */
export function getRequiredPlan(feature: FeatureKey): BillingPlan {
    return FEATURE_MIN_PLAN[feature];
}

/**
 * Get all features available on a plan.
 */
export function getAvailableFeatures(plan: BillingPlan | string): FeatureKey[] {
    return (Object.keys(FEATURE_MIN_PLAN) as FeatureKey[]).filter(f => hasFeature(plan, f));
}

// ─── Module → minimum plan (the plan dimension of module gating) ───
//
// Module availability is `(plan allows) ∧ (tenant enabled)`. This half is
// the PLAN ceiling: the minimum billing tier that unlocks each module.
// The tenant-enabled half lives in TenantModuleSettings (src/lib/modules.ts).
//
// Tiering follows the two personas: the agriculture CORE (journal /
// inventory / crop planning) is FREE so a startup farmer on "simple mode"
// gets the full working surface; the enterprise GRC + automation modules
// sit behind PRO; AI behind ENTERPRISE. A `null` plan (self-hosted /
// billing-unconfigured) allows EVERYTHING — so on-prem + dev + the GRC
// test tenants are unaffected, and the tenant toggle is the only gate.

const MODULE_MIN_PLAN: Record<ModuleKey, BillingPlan> = {
    JOURNAL: 'FREE',
    INVENTORY: 'FREE',
    PLANNING: 'FREE',
    CERTIFICATION: 'PRO',
    VENDORS: 'PRO',
    AUTOMATION: 'PRO',
    PROCESSES: 'PRO',
    AI: 'ENTERPRISE',
    // Enterprise-grain — the large grain-producer surface (storage bins,
    // marketing contracts, yield records, per-activity cost accounting,
    // lot blending). ENTERPRISE-tier value for the portfolio persona.
    GRAIN: 'ENTERPRISE',
    // Exchange is a NETWORK-EFFECT product: its value grows with the number
    // of tenants browsing + posting, so it is deliberately FREE for every
    // tier. Gating browse behind a paid plan would strangle the liquidity
    // the marketplace depends on. (Per-tenant enable/disable still applies
    // via the module toggle — FREE means "not blocked by billing plan".)
    EXCHANGE: 'FREE',
};

/** True when `plan` is high enough to unlock `key`. `null` plan ⇒ all. */
export function planAllowsModule(plan: BillingPlan | string | null, key: ModuleKey): boolean {
    if (plan == null) return true;
    const current = PLAN_LEVEL[plan as BillingPlan] ?? 0;
    const required = PLAN_LEVEL[MODULE_MIN_PLAN[key]] ?? 0;
    return current >= required;
}

/** Every module the plan unlocks (the plan ceiling, pre-tenant-toggle). */
export function planModules(plan: BillingPlan | string | null): ModuleKey[] {
    return (Object.keys(MODULE_MIN_PLAN) as ModuleKey[]).filter((k) => planAllowsModule(plan, k));
}

/** The minimum plan that unlocks a module (UI upgrade-CTA hint). */
export function getModuleMinPlan(key: ModuleKey): BillingPlan {
    return MODULE_MIN_PLAN[key];
}


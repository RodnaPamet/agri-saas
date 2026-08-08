/**
 * WP-2 — per-tenant module gating (pure helpers; no DB access).
 *
 * A module is "enabled" for a tenant when it appears in
 * `TenantModuleSettings.enabledModules`. A tenant with NO settings row
 * has ALL modules enabled (backward-compatible default) — a tenant opts
 * into "simple mode" by saving a restricted list. The DB-backed
 * resolution + the `assertModuleEnabled` gate live in
 * `src/app-layer/usecases/modules.ts`; enforcement coverage is locked by
 * `tests/guardrails/module-gate-coverage.test.ts`.
 */
import type { ModuleKey } from '@prisma/client';

export const ALL_MODULES: readonly ModuleKey[] = [
    'JOURNAL',
    'INVENTORY',
    'PLANNING',
    'CERTIFICATION',
    'VENDORS',
    'AUTOMATION',
    'PROCESSES',
    'AI',
    'GRAIN',
    'EXCHANGE',
] as const;

/**
 * "Simple mode" — the curated module set for a startup farmer. Just the
 * core ag surfaces (field journal, inventory, crop planning); none of the
 * enterprise GRC / automation modules. A tenant opts into simple mode by
 * saving this as its `TenantModuleSettings.enabledModules`. The enterprise
 * persona leaves the row null (all modules) or enables a richer set.
 *
 * Note: Tasks + Knowledge Base are NOT module-gated (always available), so
 * they aren't listed here — a simple-mode farmer still gets them.
 */
export const SIMPLE_MODE_MODULES: readonly ModuleKey[] = [
    'JOURNAL',
    'INVENTORY',
    'PLANNING',
] as const;

/** True when a tenant's enabled set is exactly the simple-mode preset. */
export function isSimpleMode(modules: readonly ModuleKey[]): boolean {
    return (
        modules.length === SIMPLE_MODE_MODULES.length &&
        SIMPLE_MODE_MODULES.every((m) => modules.includes(m))
    );
}

export const MODULE_LABELS: Record<ModuleKey, string> = {
    JOURNAL: 'Farm Journal',
    INVENTORY: 'Inventory',
    PLANNING: 'Crop Planning',
    CERTIFICATION: 'Certification & Compliance',
    VENDORS: 'Suppliers & Buyers',
    AUTOMATION: 'Automation',
    PROCESSES: 'Process Maps',
    AI: 'AI Assist',
    GRAIN: 'Grain & Trading',
    EXCHANGE: 'Exchange',
};

// MODULE_DESCRIPTIONS removed — every one of the eleven strings was
// English-only, hardcoded in a lib module a server component imports, so a
// Bulgarian operator read English on the module settings page regardless of
// locale. The copy now lives in next-intl under `admin.modules.desc_<KEY>`,
// where it is translated and where a reviewer can see both languages side by
// side.
//
// The CERTIFICATION line also described the machinery rather than the point:
// "Audit frameworks, controls, evidence, and policies" is what the module is
// built from. What a farmer is buying is "certification schemes, the records
// that prove them, and readiness for an inspection".

/**
 * Resolve a tenant's enabled modules from its settings row.
 * `null` row (the common case) → all modules enabled.
 */
export function resolveEnabledModules(row: { enabledModules: ModuleKey[] } | null | undefined): ModuleKey[] {
    if (!row) return [...ALL_MODULES];
    return row.enabledModules;
}

export function isModuleEnabledIn(modules: readonly ModuleKey[], key: ModuleKey): boolean {
    return modules.includes(key);
}

/**
 * The "compliance exoskeleton" gate for farm assets.
 *
 * An asset's GRC surfaces — control/risk traceability, inherited evidence,
 * mappings, control-test plans, and the coverage shield — only make sense for
 * a tenant that actually runs a compliance module (CERTIFICATION or RISK). A
 * plain farm (simple mode) gets a clean asset register with none of that
 * chrome. Callers pass the tenant's `availableModules` (from the tenant
 * context on the client, or `getAvailableModules` on the server); `undefined`
 * — an older provider payload with no module list — degrades to "show it", so
 * existing tenants behave exactly as before until their context re-mints.
 */
export function hasComplianceModules(
    availableModules: readonly ModuleKey[] | undefined,
): boolean {
    if (availableModules === undefined) return true;
    return availableModules.includes('CERTIFICATION');
}

/** Validate an arbitrary string[] down to known ModuleKey values. */
export function coerceModuleKeys(input: readonly string[]): ModuleKey[] {
    const set = new Set<string>(ALL_MODULES);
    return input.filter((m): m is ModuleKey => set.has(m));
}

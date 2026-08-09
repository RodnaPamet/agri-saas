'use client';

import { createContext, useContext, useCallback } from 'react';
import type { Role, ModuleKey } from '@prisma/client';
import type { PermissionSet } from '@/lib/permissions';

// ─── Tenant context ───

export interface TenantContextValue {
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    /** RQ3-OB-A — display currency for monetary surfaces (default €). */
    currencySymbol?: string;
    role: Role;
    plan?: string;
    /**
     * Modules AVAILABLE to the tenant (plan-allowed ∧ tenant-enabled),
     * resolved server-side in the tenant layout. The sidebar hides nav
     * items for unavailable modules. Absent on older providers ⇒ treat
     * as "all available" (degrade gracefully).
     */
    availableModules?: ModuleKey[];
    /**
     * #12 — whether the GLOBAL promotions catalogue has anything active. Data-driven,
     * not a module/permission flag: resolved server-side in the tenant layout so the
     * sidebar can hide the Promotions entry instead of linking every tenant to
     * an empty page. Absent ⇒ treat as "show" (degrade gracefully).
     */
    promotionsAvailable?: boolean;
    /**
     * #12 — is this the designated platform tenant (PLATFORM_TENANT_SLUG)?
     * Resolved server-side so the slug-comparison logic doesn't ship to the
     * client. Gates the support console's nav entries.
     *
     * Note the polarity is the OPPOSITE of its two neighbours above: absent ⇒
     * false, degrading CLOSED. For `availableModules` / `promotionsAvailable`
     * the worse failure is hiding a tenant's own feature, so they degrade open;
     * here the worse failure is showing a cross-tenant catalogue console to a
     * farm that should never see it.
     */
    isPlatformTenant?: boolean;
    permissions: {
        canRead: boolean;
        canWrite: boolean;
        canAdmin: boolean;
        canAudit: boolean;
        canExport: boolean;
    };
    appPermissions: PermissionSet;
}

const TenantContext = createContext<TenantContextValue | null>(null);

export function TenantProvider({
    value,
    children,
}: {
    value: TenantContextValue;
    children: React.ReactNode;
}) {
    return (
        <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
    );
}

export function useTenantContext(): TenantContextValue {
    const ctx = useContext(TenantContext);
    if (!ctx) {
        throw new Error('useTenantContext must be used within a TenantProvider');
    }
    return ctx;
}

/**
 * Hook to retrieve granular app permissions for UI rendering logic.
 */
export function usePermissions(): PermissionSet {
    return useTenantContext().appPermissions;
}

/**
 * Build a tenant-scoped href: `/t/<slug>/<path>`
 */
export function useTenantHref() {
    const { tenantSlug } = useTenantContext();
    return useCallback(
        (path: string) => `/t/${tenantSlug}${path.startsWith('/') ? path : `/${path}`}`,
        [tenantSlug]
    );
}

/**
 * Build a tenant-scoped API URL: `/api/t/<slug>/<path>`
 */
export function useTenantApiUrl() {
    const { tenantSlug } = useTenantContext();
    return useCallback(
        (path: string) => `/api/t/${tenantSlug}${path.startsWith('/') ? path : `/${path}`}`,
        [tenantSlug]
    );
}

// ─── RQ3-OB-A — tenant-bound money formatter ─────────────────────────
//
// One symbol per tenant, one formatter per product. Components call
// `useMoneyFormatter()` instead of importing formatCompactCurrency
// with a hardcoded symbol — the hook closes over the tenant's
// configured currencySymbol (default €).

import { formatCompactCurrency } from '@/lib/format-currency';

/**
 * The tenant's configured display currency SYMBOL (default €).
 *
 * Exposed separately from `useMoneyFormatter` because that formatter is
 * COMPACT (€1.2M) — right for dashboard tiles, wrong for a financial table
 * where a farmer reconciles figures against invoices and needs the cents.
 */
export function useTenantCurrencySymbol(): string {
    return useTenantContext().currencySymbol ?? '€';
}

export function useMoneyFormatter(): (v: number | null | undefined) => string {
    const ctx = useTenantContext();
    const symbol = ctx.currencySymbol ?? '€';
    return useCallback((v: number | null | undefined) => formatCompactCurrency(v, symbol), [symbol]);
}

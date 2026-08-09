'use client';

/**
 * PR-2 — `<OrgWorkspaceSwitcher>` — context-switching practice for
 * org pages.
 *
 * The tenant variant of the chrome already mounts
 * `<TenantSwitcher>` (a popover surfacing every workspace + every
 * organization the user belongs to). The org variant historically
 * mounted the PASSIVE `<OrgIdentityPill>` — a non-interactive
 * `<Link>` to `/tenants` (the unified picker page). That made
 * switching org → tenant a two-click navigation (click pill, then
 * pick destination) while switching tenant → org was a one-click
 * popover selection from inside the tenant chrome. The asymmetry
 * was visible and frustrating.
 *
 * This component restores symmetry. It mirrors `<TenantSwitcher>`
 * structurally:
 *
 *   • Same `<Popover>` shell + `<Popover.Menu>` interior
 *   • Same MENU_ROW_CLASS row recipe
 *   • Same two-section breakdown (Organizations + Workspaces)
 *   • Same `Manage workspaces` footer link
 *
 * The only difference is the **active context** the trigger pill
 * shows: an org page surfaces the active org, while a tenant page
 * surfaces the active tenant. Both can switch to either context
 * with one click.
 *
 * No reads of `useTenantContext` — that hook is undefined on org
 * pages. The active org comes from `useOrgContext()`; tenants in
 * the popover are link targets only.
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { useOrgContext } from '@/lib/org-context-provider';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';
import type {
    TenantSwitcherMembership,
    TenantSwitcherOrgMembership,
} from './tenant-switcher';

export interface OrgWorkspaceSwitcherProps {
    /**
     * Tenant memberships the popover surfaces under "Workspaces".
     * Threaded from `AppShell → TopChrome → here` (same path
     * `<TenantSwitcher>` uses).
     */
    memberships: TenantSwitcherMembership[];
    /**
     * Org memberships under "Organizations". The active org is
     * highlighted; clicking any other org switches the route.
     */
    orgMemberships: TenantSwitcherOrgMembership[];
}

// ─── Recipes — kept in lockstep with TenantSwitcher ──────────────

const SWITCHER_PILL_CLASS = `hidden sm:inline-flex items-center gap-tight rounded-full border border-border-subtle bg-bg-default px-3 py-1 text-xs font-medium text-content-muted transition-colors hover:bg-bg-muted/50 hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${NAV_BAR_SLOT_PRESS}`;

const MENU_ROW_CLASS =
    'flex w-full cursor-pointer select-none items-center justify-between gap-default rounded-md px-2.5 py-1.5 text-left text-sm text-content-default transition-colors duration-100 ease-out hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

const MENU_ROW_ACTIVE_CLASS = 'bg-bg-subtle text-content-emphasis';

export function OrgWorkspaceSwitcher({
    memberships,
    orgMemberships,
}: OrgWorkspaceSwitcherProps) {
    const t = useTranslations('switcher');
    const { orgName, orgSlug } = useOrgContext();
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={6}
            popoverContentClassName="w-[240px] p-1"
            content={
                <Popover.Menu aria-label={t('switchContext')}>
                    {/* PR-2 — Organizations come first when the
                        active context is itself an organization.
                        Mirrors TenantSwitcher's "Organizations"
                        section so users see exactly one switcher
                        UX regardless of which side they start from. */}
                    <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        {t('organizations')}
                    </p>
                    {orgMemberships.length === 0 ? (
                        <p className="px-2.5 py-3 text-xs text-content-muted">
                            {t('noOrganizations')}
                        </p>
                    ) : (
                        orgMemberships.map((o) => {
                            const isActive = o.slug === orgSlug;
                            return (
                                <Link
                                    key={o.slug}
                                    href={`/org/${o.slug}`}
                                    onClick={close}
                                    role="menuitem"
                                    aria-current={isActive ? 'page' : undefined}
                                    data-testid={`org-workspace-switcher-org-${o.slug}`}
                                    className={`${MENU_ROW_CLASS} ${isActive ? MENU_ROW_ACTIVE_CLASS : ''}`}
                                >
                                    <span className="flex items-center gap-compact min-w-0">
                                        <InitialsAvatar value={o.slug} mode="slug" />
                                        <span className="flex flex-col min-w-0">
                                            <span className="truncate text-content-emphasis">
                                                {o.slug}
                                            </span>
                                            <span className="truncate text-[10px] text-content-subtle">
                                                {t('orgRole', { role: o.role.toLowerCase().replace('org_', '') })}
                                            </span>
                                        </span>
                                    </span>
                                    {isActive && (
                                        <Check
                                            className="h-4 w-4 flex-shrink-0 text-[var(--brand-default)]"
                                            aria-hidden="true"
                                        />
                                    )}
                                </Link>
                            );
                        })
                    )}

                    <Popover.Separator />

                    <p className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-content-subtle">
                        {t('workspaces')}
                    </p>
                    {memberships.length === 0 ? (
                        <p className="px-2.5 py-3 text-xs text-content-muted">
                            {t('noWorkspaces')}
                        </p>
                    ) : (
                        memberships.map((m) => (
                            <Link
                                key={m.slug}
                                href={`/t/${m.slug}/dashboard`}
                                onClick={close}
                                role="menuitem"
                                data-testid={`org-workspace-switcher-tenant-${m.slug}`}
                                className={MENU_ROW_CLASS}
                            >
                                <span className="flex items-center gap-compact min-w-0">
                                    <InitialsAvatar value={m.slug} mode="slug" />
                                    <span className="flex flex-col min-w-0">
                                        <span className="truncate text-content-emphasis">
                                            {m.slug}
                                        </span>
                                        <span className="truncate text-[10px] text-content-subtle">
                                            {m.role.toLowerCase()}
                                        </span>
                                    </span>
                                </span>
                            </Link>
                        ))
                    )}

                    <Popover.Separator />

                    <Link
                        href="/tenants"
                        onClick={close}
                        role="menuitem"
                        data-testid="org-workspace-switcher-manage"
                        className={MENU_ROW_CLASS}
                    >
                        <span className="text-content-muted">
                            {t('manageWorkspaces')}
                        </span>
                    </Link>
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={SWITCHER_PILL_CLASS}
                aria-label={t('currentOrganization', { name: orgName })}
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-org-switcher"
            >
                <InitialsAvatar value={orgSlug} mode="slug" />
                <span className="max-w-trunc-tight truncate">{orgName}</span>
                <ChevronsUpDown
                    className="h-3 w-3 flex-shrink-0 text-content-subtle"
                    aria-hidden="true"
                />
            </button>
        </Popover>
    );
}

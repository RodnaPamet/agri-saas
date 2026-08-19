'use client';

/**
 * Roadmap-14 PR-5 — `<UserMenu>` — right-slot avatar + dropdown.
 *
 * Mounts to the right of every workspace-aware top-bar surface
 * (tenant or org variant). Provides the canonical home for
 * account-scoped verbs:
 *
 *   • Theme toggle (light / dark)
 *   • Sign out
 *
 * Future PRs may extend with Profile, Account settings, Keyboard
 * shortcuts (already exists, triggered by `?` key). PR-5 keeps the
 * menu intentionally small — adding items the user can't reach via
 * a real route would be misleading.
 *
 * The avatar trigger replaces the sidebar's "log-out icon at the
 * bottom" affordance as the global account-actions home; the
 * sidebar's existing identity panel + log-out icon stay in place
 * until R14-PR12 mobile unification, when they're consolidated
 * here.
 *
 * Data: `useSession()` for the display name. Falls back to
 * "Account" when name is unset (legitimate state for unauth-during-
 * hydration; the menu itself never renders unauthed because
 * `<AppShell>` doesn't mount).
 *
 * Visual: 32×32 round avatar with the user's initials over a
 * brand-subtle fill. Hover brightens (motion-language safe). The
 * dropdown opens to `align="end"` so it hugs the right edge of the
 * viewport and never overflows.
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { signOutAndPurge } from '@/lib/auth/sign-out';
import { LogOut, ShieldCheck } from 'lucide-react';

import { Popover } from '@/components/ui/popover';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { UserMenuLanguageToggle } from './UserMenuLanguageToggle';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';

// ─── Props ────────────────────────────────────────────────────────

export interface UserMenuProps {
    /**
     * Display name + email threaded from the server-side layout.
     * Replaces the R14-PR5 `useSession()` call that violated the
     * project's no-SessionProvider convention. `null` is the
     * legitimate "unset" state (rendered as "Account" fallback).
     */
    displayName: string | null;
    displayEmail: string | null;
    /**
     * Profile-photo URL — OAuth `User.image` written at sign-in OR
     * the in-app serve URL from the avatar upload flow. Surfaced in
     * the avatar trigger; initials remain the fallback layer. Avatar
     * roadmap P4. JWT-lag note: after a fresh upload, this lags until
     * the next JWT re-mint, but the member list (DB-backed) updates
     * immediately.
     */
    displayImage: string | null;
}

// ─── Recipe ────────────────────────────────────────────────────────

// Wraps the shared `<InitialsAvatar size="md">` (which owns the
// circle's fill, sizing, and initials styling). The button class
// supplies the click target, hover lift, focus ring, and press
// motion — visual styles the avatar primitive deliberately does not
// carry.
const AVATAR_BUTTON_CLASS =
    `inline-flex h-[22px] w-[22px] items-center justify-center rounded-full transition-[filter] duration-150 ease-out hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-page ${NAV_BAR_SLOT_PRESS}`;

const MENU_ROW_CLASS =
    'flex w-full cursor-pointer select-none items-center gap-compact rounded-md px-2.5 py-1.5 text-left text-sm text-content-default transition-colors duration-100 ease-out hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

export function UserMenu({
    displayName,
    displayEmail,
    displayImage,
}: UserMenuProps) {
    const t = useTranslations('userMenu');
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);

    // Trim + fallback. `null` or whitespace-only renders as
    // "Account" so the chrome never shows an empty trigger.
    const resolvedName = displayName?.trim() ?? '';
    const effectiveName = resolvedName.length > 0 ? resolvedName : t('accountFallback');

    const handleSignOut = useCallback(async () => {
        close();
        await signOutAndPurge({ callbackUrl: '/login' });
    }, [close]);

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={8}
            popoverContentClassName="w-[240px] p-1"
            content={
                <Popover.Menu aria-label={t('accountMenu')}>
                    {/* Identity header — name + email at the top.
                        Quiet typography so the eye reads the
                        actionable items below, not the header. */}
                    <div className="px-2.5 pt-1.5 pb-2">
                        <p
                            className="truncate text-sm font-medium text-content-emphasis"
                            data-testid="user-menu-display-name"
                        >
                            {effectiveName}
                        </p>
                        {displayEmail && (
                            <p
                                className="truncate text-xs text-content-muted"
                                data-testid="user-menu-display-email"
                            >
                                {displayEmail}
                            </p>
                        )}
                    </div>

                    <Popover.Separator />

                    {/* Theme toggle. Mounted INSIDE the menu so the
                        sidebar can retire its own toggle in
                        R14-PR12. ThemeToggle handles its own
                        keyboard story + persists to localStorage. */}
                    <div
                        className="px-2.5 py-1.5 flex items-center justify-between text-sm text-content-default"
                        data-testid="user-menu-theme-row"
                    >
                        <span>{t('theme')}</span>
                        <ThemeToggle id="user-menu-theme-toggle" />
                    </div>

                    {/* UI language — the per-user locale switch, paired
                        directly beneath Theme (both are personal, not
                        tenant-scoped). Persists to User.uiLanguage +
                        refreshes the server tree in the new locale. */}
                    <div
                        className="px-2.5 py-1.5 flex items-center justify-between text-sm text-content-default"
                        data-testid="user-menu-language-row"
                    >
                        <span>{t('language')}</span>
                        <UserMenuLanguageToggle />
                    </div>

                    <Popover.Separator />

                    {/* Account security — navigation to the
                        password-change surface. */}
                    <Link
                        href="/account/security"
                        role="menuitem"
                        data-testid="user-menu-account-security"
                        onClick={close}
                        className={MENU_ROW_CLASS}
                    >
                        <ShieldCheck className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                        <span>{t('accountSecurity')}</span>
                    </Link>

                    <Popover.Separator />

                    {/* Sign out — the destructive action at the
                        end of the menu, separated from the
                        non-destructive items above. */}
                    <button
                        type="button"
                        onClick={handleSignOut}
                        role="menuitem"
                        data-testid="user-menu-sign-out"
                        className={MENU_ROW_CLASS}
                    >
                        <LogOut className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                        <span>{t('signOut')}</span>
                    </button>
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={AVATAR_BUTTON_CLASS}
                aria-label={t('accountMenuFor', { name: effectiveName })}
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-user-menu"
            >
                <InitialsAvatar
                    value={effectiveName}
                    size="nav"
                    imageUrl={displayImage}
                />
            </button>
        </Popover>
    );
}

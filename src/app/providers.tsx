'use client';

// Side effect — disable Zod's eval-based JIT before any schema parses,
// so the strict CSP doesn't report Zod's `new Function` probe. Keep at
// the top of the client entry. See src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { useEffect, useState } from 'react';
import { Toaster } from 'sonner';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    CommandPalette,
    CommandPaletteProvider,
} from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { ShortcutHelpOverlay } from '@/components/app-shell/shortcut-help-overlay';
import { registerFormTelemetrySink } from '@/lib/telemetry/form-telemetry';
import { SWRPersistenceProvider } from '@/components/providers/SWRPersistenceProvider';
import { setCurrentUserId } from '@/lib/offline/current-user';
import { ViewTransitions } from '@/lib/view-transitions';

/**
 * Epic 54 — bootstrap the global form-telemetry sink once at mount.
 *
 * The sink is intentionally a no-op in open-source mode: a real
 * observability stack (Sentry breadcrumb + PostHog track) can swap in
 * a richer handler from `src/lib/observability/` without touching any
 * modal call site. For local / Playwright visibility of form events,
 * developers set `window.__INFLECT_FORM_TELEMETRY__` from DevTools or
 * a test setup — the hook honours it independent of the sink
 * registered here.
 *
 * We DO register the no-op explicitly (rather than leaving the sink
 * unset) so the hook's `registered === true` check is satisfied and
 * future migrations of the sink don't have to re-discover whether
 * `Providers` already initialised it.
 */
function useFormTelemetryBootstrap() {
    useEffect(() => {
        registerFormTelemetrySink(() => {
            /* wired by the observability layer */
        });
    }, []);
}

function FormTelemetrySink() {
    useFormTelemetryBootstrap();
    return null;
}

/**
 * Roadmap-6 P4 — thumb-zone toast placement.
 *
 * On mobile (< md, where the fixed BottomTabBar + sticky top chrome
 * both live) toasts anchor BOTTOM-CENTRE so the Undo / Close affordance
 * lands in the natural thumb zone and stays clear of the sticky top
 * bar. The bottom offset clears the 3.5rem tab bar + the device
 * safe-area (mirrors the FAB / bottom-tab-spacer offset). On md+ there
 * is no bottom bar, so we keep the conventional desktop TOP-RIGHT slot.
 *
 * `isMdUp` starts `true` so SSR + first client paint match the desktop
 * default (no hydration mismatch); the effect resolves the real
 * viewport on mount. No toast is visible at mount, so the one-frame
 * reconcile is invisible. Sonner switches to `--mobile-offset-*` below
 * its own 600px breakpoint, so we pass BOTH `offset` (600–767px) and
 * `mobileOffset` (< 600px) to keep the tab-bar clearance consistent
 * across the whole < md range.
 */
const MOBILE_TOAST_BOTTOM_OFFSET = 'calc(3.5rem + env(safe-area-inset-bottom) + 1rem)';

export function ResponsiveToaster() {
    const [isMdUp, setIsMdUp] = useState(true);
    useEffect(() => {
        const mql = window.matchMedia('(min-width: 768px)');
        const sync = () => setIsMdUp(mql.matches);
        sync();
        mql.addEventListener('change', sync);
        return () => mql.removeEventListener('change', sync);
    }, []);
    return (
        <Toaster
            theme="dark"
            position={isMdUp ? 'top-right' : 'bottom-center'}
            offset={isMdUp ? undefined : { bottom: MOBILE_TOAST_BOTTOM_OFFSET }}
            mobileOffset={{ bottom: MOBILE_TOAST_BOTTOM_OFFSET }}
            richColors
            closeButton
            duration={3000}
        />
    );
}

export function Providers({
    children,
    userId,
}: {
    children: React.ReactNode;
    /** Signed-in user id from the root layout — namespaces the SWR cache. */
    userId?: string | null;
}) {
    // No <SessionProvider>. The tenant layout resolves the session
    // server-side via `auth()`, nothing calls `useSession`, and
    // `signIn`/`signOut` work without the provider. Mounting it would
    // trigger a client-side `/api/auth/session` fetch on every page
    // load that frequently aborts when tests/users navigate away,
    // producing "Failed to fetch" noise in the console.
    // Epic 57 — `KeyboardShortcutProvider` owns the single window
    // keydown listener that routes every registered shortcut. It wraps
    // the theme + tooltip providers so shortcuts can reach into the
    // tree without every page re-mounting its own listener.
    // Epic 57 — `CommandPaletteProvider` sits INSIDE the shortcut
    // provider so it can register `mod+k` on the shared registry. The
    // palette itself is rendered once at the shell so it's reachable
    // from any route, layered above page content via its own portal.
    // Roadmap-6 P3 — `SWRPersistenceProvider` sits at the top so EVERY
    // client read (all `useTenantSWR` / `useSWR` call sites) shares the
    // one per-tenant, disk-backed SWR cache. A PWA relaunch then paints
    // lists from the on-device cache instead of refetching the whole
    // farm over rural LTE.
    // The offline layer needs to know WHO is signed in, and it is not a React
    // consumer: `enqueue` runs from a hook, `flushOutbox` is a pure function,
    // and the service worker replays with no React at all. One module-scoped
    // value, set here from the same server-resolved id that namespaces the SWR
    // cache, is readable from all three. Set during render rather than in an
    // effect so an enqueue on the very first interaction is already attributed.
    setCurrentUserId(userId);

    return (
        <SWRPersistenceProvider userId={userId}>
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <ThemeProvider>
                    <TooltipProvider>
                        <FormTelemetrySink />
                        {/*
                         * mobile-native-feel PR-3 — route view-transitions.
                         * A pass-through wrapper that installs the capture-
                         * phase link interceptor. Enhancement is mobile-only
                         * + reduced-motion-aware + feature-detected, so
                         * desktop and reduced-motion users are untouched.
                         */}
                        <ViewTransitions>{children}</ViewTransitions>
                        <CommandPalette />
                        {/*
                         * Epic 57 — `?` pops a live listing of every
                         * registered shortcut. Mounted once at the shell so
                         * the registry is the single source of truth and
                         * shortcuts registered deeper in the tree appear
                         * automatically.
                         */}
                        <ShortcutHelpOverlay />
                        {/*
                         * Global toast host. CopyButton / CopyText and the
                         * optimistic-update hook emit into this Toaster;
                         * without it, every `toast()` call is a silent no-op.
                         * Position is viewport-responsive — see
                         * <ResponsiveToaster> above.
                         */}
                        <ResponsiveToaster />
                    </TooltipProvider>
                </ThemeProvider>
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
        </SWRPersistenceProvider>
    );
}

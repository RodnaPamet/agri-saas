'use client';

/**
 * Epic 51 — theme provider & `useTheme()` hook.
 *
 * Thin client-side layer that flips `html[data-theme]` between `"dark"` (the
 * default) and `"light"`, persisting the user's choice in localStorage and
 * honouring the system `prefers-color-scheme` for the first visit.
 *
 * The actual colour values live in `src/styles/tokens.css`. This file only
 * decides *which palette* is active; every token-driven component gets the
 * switch for free.
 *
 * The provider must mount inside the root layout (client-side); it does not
 * render anything and has no performance cost on SSR. Reading `useTheme()`
 * before the provider mounts returns `"dark"` (the baseline) — consistent
 * with SSR snapshots.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

export type Theme = 'dark' | 'light' | 'sunlight';

/**
 * Cycle order for the toggle: dark → light → sunlight → dark. "sunlight" is
 * the high-contrast outdoor palette (readable in bright field light); it sits
 * after light so the two daytime palettes are adjacent.
 */
export const THEME_CYCLE: readonly Theme[] = ['dark', 'light', 'sunlight'];

function isTheme(value: unknown): value is Theme {
    return value === 'dark' || value === 'light' || value === 'sunlight';
}

export interface ThemeContextValue {
    theme: Theme;
    setTheme: (next: Theme) => void;
    toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'inflect:theme';
const ATTR = 'data-theme';

function readInitialTheme(): Theme {
    if (typeof window === 'undefined') return 'dark';
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (isTheme(stored)) return stored;
    } catch {
        // localStorage may throw in private / sandboxed contexts — ignore.
    }
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
}

const CONTRAST_ATTR = 'data-contrast';

function applyTheme(theme: Theme) {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    if (theme === 'sunlight') {
        // Sunlight is the light palette plus a high-contrast overlay — set
        // both attributes so it inherits every light token and only the
        // contrast overrides apply on top (see tokens.css [data-contrast]).
        el.setAttribute(ATTR, 'light');
        el.setAttribute(CONTRAST_ATTR, 'high');
    } else {
        el.setAttribute(ATTR, theme);
        el.removeAttribute(CONTRAST_ATTR);
    }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    // Start in dark (the SSR default) and rehydrate on mount to avoid a
    // hydration mismatch when the stored theme differs from the SSR snapshot.
    const [theme, setThemeState] = useState<Theme>('dark');
    const hasHydrated = useRef(false);

    useEffect(() => {
        if (hasHydrated.current) return;
        hasHydrated.current = true;
        const next = readInitialTheme();
        setThemeState(next);
        applyTheme(next);
    }, []);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        applyTheme(next);
        try {
            window.localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // ignore — non-persisting is acceptable
        }
    }, []);

    const toggle = useCallback(() => {
        const idx = THEME_CYCLE.indexOf(theme);
        const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
        setTheme(next);
    }, [theme, setTheme]);

    const value = useMemo(
        () => ({ theme, setTheme, toggle }),
        [theme, setTheme, toggle],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Access the current theme and practices. Safe to call outside a provider —
 * returns a no-op `setTheme` / `toggle` plus the SSR-safe default, so feature
 * flags can render a toggle without forcing the provider everywhere.
 */
export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (ctx) return ctx;
    return {
        theme: 'dark',
        setTheme: () => {},
        toggle: () => {},
    };
}

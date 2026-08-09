'use client';

/**
 * Epic 57 — Command Palette provider.
 *
 * Owns the `open` state for the app-wide palette and registers the
 * canonical invocation shortcut (`mod+k`) on the shared keyboard
 * registry. Mounting this provider is enough to make ⌘K / Ctrl+K
 * work from anywhere in the tree — including from inside an input
 * or on top of a modal (the palette stacks above other overlays).
 *
 * Any client component can open / close the palette programmatically:
 *
 *   const { open, close, toggle, isOpen } = useCommandPalette();
 *
 * The `<CommandPalette>` surface reads this context; it renders via a
 * Radix Dialog portal when `isOpen` is true and is a no-op otherwise.
 */

import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from 'react';

import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';

export interface CommandPaletteApi {
    isOpen: boolean;
    open: () => void;
    close: () => void;
    toggle: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteApi | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);

    const open = useCallback(() => setIsOpen(true), []);
    const close = useCallback(() => setIsOpen(false), []);
    const toggle = useCallback(() => setIsOpen((v) => !v), []);

    // mod+k — meta+k on Mac, ctrl+k elsewhere. The palette is a
    // cross-context affordance: it must open on top of any modal /
    // sheet, and it must open even when the user is mid-typing in a
    // form field. Priority is high so nothing else can shadow it.
    useKeyboardShortcut('mod+k', toggle, {
        allowInInputs: true,
        allowWhenOverlayOpen: true,
        priority: 100,
        description: 'Open command palette',
    });

    const api = useMemo<CommandPaletteApi>(
        () => ({ isOpen, open, close, toggle }),
        [isOpen, open, close, toggle],
    );

    return (
        <CommandPaletteContext.Provider value={api}>
            {children}
        </CommandPaletteContext.Provider>
    );
}

/**
 * Access the palette's open state + practices. Safe to call outside
 * the provider — returns an inert API whose mutators are no-ops, so
 * unit tests rendered without the provider don't explode.
 */
export function useCommandPalette(): CommandPaletteApi {
    const ctx = useContext(CommandPaletteContext);
    if (ctx) return ctx;
    return {
        isOpen: false,
        open: () => {},
        close: () => {},
        toggle: () => {},
    };
}

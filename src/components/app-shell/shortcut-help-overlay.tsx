"use client";

/**
 * Epic 57 — shortcut help overlay.
 *
 * Press `?` anywhere in the app to pop a modal listing every keyboard
 * shortcut the registry currently knows about. The listing is LIVE —
 * `useRegisteredShortcuts()` subscribes to the provider, so shortcuts
 * mounted deep in a route (overlay-scoped keys inside a modal, say)
 * appear automatically while that route is active and vanish when
 * they unmount.
 *
 * ## Design choices
 *
 * - **Single source of truth.** No hardcoded shortcut list anywhere.
 *   The registry owns it; this component only presents it. If a
 *   shortcut lacks a `description`, the palette can't surface it and
 *   this overlay hides it too — the policy is uniform: "label it or
 *   it's internal".
 *
 * - **Typing-safe.** `useKeyboardShortcut('?')` inherits the registry's
 *   default `allowInInputs: false`, so the help modal never hijacks
 *   the `?` keystroke while a user is composing in an input, textarea,
 *   or contenteditable (Lexical / Tiptap / cmdk). The palette's own
 *   input stays untouched.
 *
 * - **Overlay-scope close.** We don't re-implement Escape — Radix
 *   Dialog (inside the shared `<Modal>`) already handles Escape +
 *   backdrop click + focus trap. The `?` shortcut itself toggles
 *   open/close as a convenience.
 *
 * - **Grouping by scope.** The registry exposes `scope: 'global' |
 *   'overlay'`. Global shortcuts are always available; overlay ones
 *   only matter while a modal or sheet is open. Splitting them in
 *   the listing makes the user's mental model match the registry's
 *   runtime behaviour.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useKeyboardShortcut, useRegisteredShortcuts } from "@/lib/hooks/use-keyboard-shortcut";
import { Modal } from "@/components/ui/modal";
import { Heading } from '@/components/ui/typography';

const OPEN_HELP_KEY = "?";

interface DisplayShortcut {
    id: string;
    keys: string[];
    scope: "global" | "overlay";
    description: string;
}

function sortByDescription(a: DisplayShortcut, b: DisplayShortcut): number {
    return a.description.localeCompare(b.description);
}

/**
 * Format `mod+k` → `Ctrl + K` on non-Mac, `⌘ + K` on Mac.
 * Also prettifies common single-key representations (`?` → `?`,
 * `Escape` → `Esc`, arrow names, …).
 */
function prettyKey(raw: string, isMac: boolean): string {
    return raw
        .split("+")
        .map((part) => {
            switch (part.trim().toLowerCase()) {
                case "mod":
                    return isMac ? "⌘" : "Ctrl";
                case "meta":
                case "cmd":
                case "command":
                    return "⌘";
                case "ctrl":
                case "practice":
                    return "Ctrl";
                case "alt":
                case "option":
                case "opt":
                    return isMac ? "⌥" : "Alt";
                case "shift":
                    return "⇧";
                case "escape":
                case "esc":
                    return "Esc";
                case "enter":
                case "return":
                    return "Enter";
                case "arrowup":
                    return "↑";
                case "arrowdown":
                    return "↓";
                case "arrowleft":
                    return "←";
                case "arrowright":
                    return "→";
                case "space":
                case " ":
                    return "Space";
                default:
                    // Uppercase single letters, leave symbols alone.
                    return part.length === 1 ? part.toUpperCase() : part;
            }
        })
        .join(" + ");
}

function isMacUserAgent(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function ShortcutHelpOverlay() {
    const t = useTranslations('shortcutHelp');
    const [open, setOpen] = useState(false);

    // Toggle on `?`. allowInInputs stays at its default (false) so
    // typing `?` in any editable target is preserved. The overlay's
    // own scope is 'global' — we want it reachable anywhere there's
    // no editable focus, even while a modal/sheet is open. Overlay-
    // scope disallows firing while an overlay IS open; that'd be a
    // dead end here. Instead pass `allowWhenOverlayOpen: true` so
    // `?` works on top of other surfaces.
    useKeyboardShortcut(
        OPEN_HELP_KEY,
        () => setOpen((prev) => !prev),
        {
            description: t('showShortcuts'),
            allowWhenOverlayOpen: true,
        },
    );

    const shortcuts = useRegisteredShortcuts();

    const { globalRows, overlayRows } = useMemo(() => {
        const displayable: DisplayShortcut[] = [];
        for (const s of shortcuts) {
            // Policy: unlabeled shortcuts are considered internal and
            // stay hidden. Contributors register with `description` to
            // make a shortcut discoverable (same bar the palette uses).
            if (!s.description) continue;
            displayable.push({
                id: s.id,
                keys: s.keys,
                scope: s.scope,
                description: s.description,
            });
        }
        displayable.sort(sortByDescription);
        return {
            globalRows: displayable.filter((s) => s.scope === "global"),
            overlayRows: displayable.filter((s) => s.scope === "overlay"),
        };
    }, [shortcuts]);

    // useMemo accepts a function reference, not just an inline arrow.
    // The Compiler rule prefers `useMemo(() => isMacUserAgent(), [])`
    // for static analysis, but the runtime semantics are identical.
    // eslint-disable-next-line react-hooks/use-memo
    const isMac = useMemo(isMacUserAgent, []);

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={t('title')}
            description={t('description')}
        >
            <Modal.Header
                title={t('title')}
                description={t('description')}
            />
            <Modal.Body className="space-y-section" data-testid="shortcut-help-body">
                <Group
                    title={t('availableNow')}
                    emptyHint={t('emptyHint')}
                    rows={globalRows}
                    isMac={isMac}
                />
                {overlayRows.length > 0 && (
                    <Group
                        title={t('inDialogsAndSheets')}
                        emptyHint=""
                        rows={overlayRows}
                        isMac={isMac}
                    />
                )}
            </Modal.Body>
        </Modal>
    );
}

function Group({
    title,
    emptyHint,
    rows,
    isMac,
}: {
    title: string;
    emptyHint: string;
    rows: DisplayShortcut[];
    isMac: boolean;
}) {
    if (rows.length === 0) {
        return (
            <div>
                <Heading level={3} className="mb-2">
                    {title}
                </Heading>
                <p className="text-sm text-content-subtle">{emptyHint}</p>
            </div>
        );
    }
    return (
        <div>
            <Heading level={3} className="mb-2">
                {title}
            </Heading>
            <ul className="divide-y divide-border-subtle" role="list">
                {rows.map((row) => (
                    <li
                        key={row.id}
                        className="flex items-center justify-between gap-default py-2 text-sm"
                    >
                        <span className="text-content-default">
                            {row.description}
                        </span>
                        <span className="flex flex-wrap items-center gap-1 text-xs">
                            {row.keys.map((k, i) => (
                                <kbd
                                    key={`${row.id}-${i}`}
                                    className="rounded border border-border-subtle bg-bg-subtle px-2 py-0.5 font-mono text-[11px] text-content-emphasis"
                                >
                                    {prettyKey(k, isMac)}
                                </kbd>
                            ))}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

"use client";

/**
 * R31 Bundle 8 (PR 9) — Canvas command palette.
 *
 * A keyboard-first action surface for the Processes canvas. Opens
 * on `/` (or via `useCanvasCommandPalette().open()` from any peer
 * within the canvas subtree). Lists every R28 / R29 / R30 canvas
 * action — undo, redo, save, snap toggle, group, ungroup, align,
 * distribute, bulk delete, fit view — with the keyboard shortcut
 * registered against each one.
 *
 * Why a CANVAS-LOCAL palette instead of registering canvas actions
 * into the app-wide Cmd+K palette?
 *   • The app palette (`<CommandPalette>` under
 *     `command-palette/command-palette.tsx`) is tenant-scoped +
 *     navigation-shaped: it knows about practices, risks, policies,
 *     etc. Canvas verbs (Group selected, Align left, …) only have
 *     meaning when you're standing on the canvas, with a selection
 *     state that lives ENTIRELY inside this subtree.
 *   • A separate palette on `/` doesn't shadow Cmd+K — both work,
 *     each scoped to where it makes sense.
 *
 * Wire-up: the palette is OPENED by `/` (a `useKeyboardShortcut`
 * binding that defaults to `allowInInputs: false`, so it doesn't
 * fire when the user is typing in a label / inspector input).
 * Each command's `onSelect` is the canvas's callback directly —
 * no second source of truth.
 */

import * as Dialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { cn } from "@/lib/cn";
import { Command } from "cmdk";
import { useCallback, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Magnifier } from "@/components/ui/icons/nucleo/magnifier";

import { useKeyboardShortcut } from "@/lib/hooks/use-keyboard-shortcut";

/** One row in the palette — keep the type tight so callers can't drift. */
export interface CanvasCommand {
    id: string;
    label: string;
    /** Optional short description below the label. */
    description?: string;
    /** Optional keyboard shortcut hint shown on the right (e.g. `⌘Z`). */
    shortcut?: string;
    /** Optional icon (lucide). */
    icon?: ReactNode;
    /** Disabled commands render quiet + non-selectable. */
    disabled?: boolean;
    /** Fired when the user picks the command. The palette closes on its own. */
    onSelect: () => void;
}

export interface CanvasCommandGroup {
    /** Group heading shown above the items. Omit for a single-group palette. */
    heading?: string;
    commands: CanvasCommand[];
}

export interface CanvasCommandPaletteProps {
    groups: CanvasCommandGroup[];
}

export function CanvasCommandPalette({ groups }: CanvasCommandPaletteProps) {
    const t = useTranslations("ui");
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState("");

    const open = useCallback(() => {
        setQuery("");
        setIsOpen(true);
    }, []);
    const close = useCallback(() => setIsOpen(false), []);

    // `/` is the conventional power-user trigger inside an editor
    // surface (Notion, Linear, Slack). The shortcut hook defaults
    // to `allowInInputs: false`, so typing `/` in the inspector
    // label field won't accidentally fire.
    useKeyboardShortcut("/", open, {
        description: t("canvasCommandPalette.openShortcut"),
        // The canvas can be mounted under a modal (e.g. a future
        // preview overlay); keep this scoped to global mode so
        // it doesn't fight modal context.
    });

    return (
        <Dialog.Root open={isOpen} onOpenChange={(next) => !next && close()}>
            <Dialog.Portal>
                <Dialog.Overlay
                    data-modal-overlay
                    className={cn(
                        "fixed inset-0 z-50",
                        "bg-bg-overlay backdrop-blur-sm",
                        "data-[state=open]:animate-fade-in",
                    )}
                />
                <Dialog.Content
                    aria-label={t("canvasCommandPalette.ariaLabel")}
                    className={cn(
                        "fixed left-1/2 top-[20%] z-50 w-[92vw] max-w-[560px]",
                        "-translate-x-1/2",
                        "rounded-xl border border-border-default bg-bg-elevated shadow-2xl",
                        "text-content-emphasis",
                        "data-[state=open]:animate-fade-in",
                        "focus-visible:outline-none",
                    )}
                    data-canvas-command-palette="true"
                >
                    <VisuallyHidden.Root>
                        <Dialog.Title>{t("canvasCommandPalette.title")}</Dialog.Title>
                        <Dialog.Description>
                            {t("canvasCommandPalette.description")}
                        </Dialog.Description>
                    </VisuallyHidden.Root>

                    <Command loop label={t("canvasCommandPalette.title")} className="flex flex-col">
                        <div
                            className={cn(
                                "flex items-center gap-tight border-b border-border-subtle",
                                "px-4 py-3",
                            )}
                        >
                            <Magnifier
                                className="size-4 shrink-0 text-content-muted"
                                aria-hidden="true"
                            />
                            <Command.Input
                                autoFocus
                                value={query}
                                onValueChange={setQuery}
                                placeholder={t("canvasCommandPalette.searchPlaceholder")}
                                className={cn(
                                    "flex-1 bg-transparent text-sm",
                                    "text-content-emphasis placeholder:text-content-subtle",
                                    "focus:outline-none",
                                )}
                                data-testid="canvas-command-palette-input"
                            />
                        </div>

                        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
                            <Command.Empty
                                className="px-3 py-6 text-center text-xs text-content-subtle"
                            >
                                {t("canvasCommandPalette.empty")}
                            </Command.Empty>
                            {groups.map((group, gi) => (
                                <Command.Group
                                    key={group.heading ?? `g-${gi}`}
                                    heading={group.heading}
                                    className={cn(
                                        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1",
                                        "[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold",
                                        "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider",
                                        "[&_[cmdk-group-heading]]:text-content-subtle",
                                    )}
                                >
                                    {group.commands.map((cmd) => (
                                        <Command.Item
                                            key={cmd.id}
                                            value={`${cmd.label} ${cmd.description ?? ""}`}
                                            disabled={cmd.disabled}
                                            onSelect={() => {
                                                if (cmd.disabled) return;
                                                cmd.onSelect();
                                                close();
                                            }}
                                            className={cn(
                                                "flex items-center gap-tight rounded-md px-2 py-2 text-sm",
                                                "text-content-emphasis cursor-pointer",
                                                "data-[selected=true]:bg-bg-muted",
                                                "data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
                                            )}
                                            data-testid={`canvas-command-${cmd.id}`}
                                        >
                                            {cmd.icon && (
                                                <span
                                                    className="text-content-muted"
                                                    aria-hidden="true"
                                                >
                                                    {cmd.icon}
                                                </span>
                                            )}
                                            <div className="flex min-w-0 flex-col">
                                                <span className="truncate">
                                                    {cmd.label}
                                                </span>
                                                {cmd.description && (
                                                    <span className="truncate text-[10px] text-content-subtle">
                                                        {cmd.description}
                                                    </span>
                                                )}
                                            </div>
                                            {cmd.shortcut && (
                                                <kbd
                                                    className="ml-auto rounded border border-border-subtle bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-content-muted"
                                                >
                                                    {cmd.shortcut}
                                                </kbd>
                                            )}
                                        </Command.Item>
                                    ))}
                                </Command.Group>
                            ))}
                        </Command.List>
                    </Command>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

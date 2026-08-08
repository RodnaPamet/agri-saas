'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 57 — Command Palette surface.
 *
 * Hosts `cmdk` inside a Radix Dialog so the palette gets the same
 * focus-trap, backdrop, and portal guarantees as every other Inflect
 * overlay. Opening is handled by the `CommandPaletteProvider` (which
 * owns the `mod+k` shortcut); this file only renders the surface.
 *
 * The palette is deliberately minimal on first mount — a search input,
 * an empty state, and a "Keyboard shortcuts" group seeded from the
 * shared registry. Later Epic 57 prompts will layer in:
 *   - navigation commands (tenant-aware routes)
 *   - entity search (controls, policies, tasks, evidence, …)
 *   - quick actions (new control, toggle theme, sign out, …)
 *
 * Adding a group is declarative: feed `Command.Group` with an array
 * of items. No palette-local state beyond the search query and the
 * selected item — both owned by cmdk.
 *
 * Accessibility:
 *   - Radix Dialog provides `role="dialog"` + focus trap + Escape close.
 *   - A visually-hidden `Dialog.Title` satisfies Radix's a11y contract.
 *   - cmdk's `Command.Input` carries `role="combobox"` + `aria-expanded`
 *     + `aria-controls`; selected items emit `data-selected="true"`.
 */

import * as Dialog from '@radix-ui/react-dialog';
import * as VisuallyHidden from '@radix-ui/react-visually-hidden';
import { cn } from '@/lib/cn';
import { Command } from 'cmdk';
import {
    BookOpen,
    CheckSquare,
    FileText,
    FlaskConical,
    Layers,
    Package,
    Paperclip,
    Search,
    ShieldCheck,
    Triangle,
    type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
    useRegisteredShortcuts,
    type RegisteredShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';

import { useCommandPalette } from './command-palette-provider';
import {
    tenantSlugFromPathname,
    useEntitySearch,
    type EntityKind,
    type EntitySearchResult,
} from './use-entity-search';
import { useLocalStorage } from '@/components/ui/hooks';
import {
    MAX_RECENTS,
    addRecent,
    loadRecents,
    recentsStorageKey,
    serializeRecents,
    type RecentItem,
} from '@/lib/palette/recents';
import {
    countHitsByKind,
    filterHitsByKind,
    toggleKind,
} from '@/lib/palette/filter';
import { SEARCH_TYPE_DEFAULTS, type SearchHitType } from '@/lib/search/types';
import {
    filterPaletteCommands,
    usePaletteCommands,
    type PaletteCommand,
} from './use-palette-commands';

// ─── Key rendering helpers ─────────────────────────────────────────────

function isMac(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

function prettifyKeyToken(token: string): string {
    const t = token.trim().toLowerCase();
    if (t === 'mod') return isMac() ? '⌘' : 'Ctrl';
    if (t === 'meta' || t === 'cmd' || t === 'command') return '⌘';
    if (t === 'ctrl' || t === 'control') return 'Ctrl';
    // macOS uses the glyph U+2325 for Option, but our UI-chrome
    // guardrail (tests/guardrails/no-emoji-icons.test.ts) blocks it.
    // Render text "Alt" on both platforms — recognisable everywhere.
    if (t === 'alt' || t === 'opt' || t === 'option') return 'Alt';
    if (t === 'shift') return '⇧';
    if (t === 'enter' || t === 'return') return '↵';
    if (t === 'escape' || t === 'esc') return 'Esc';
    if (t === 'arrowup') return '↑';
    if (t === 'arrowdown') return '↓';
    if (t === 'arrowleft') return '←';
    if (t === 'arrowright') return '→';
    if (t.length === 1) return t.toUpperCase();
    // Named key: "Tab", "Backspace", "Delete", etc. Title-case it.
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function renderShortcut(raw: string): ReactNode {
    // Split on `+`, preserving a literal trailing `+` the parser lets through.
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '+' && buf.length > 0 && i < raw.length - 1) {
            parts.push(buf);
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf.length > 0) parts.push(buf);

    return parts.map((p, i) => (
        <kbd
            key={`${p}-${i}`}
            className={cn(
                'ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center',
                'rounded border border-border-subtle bg-bg-muted px-1.5',
                'text-[10px] font-medium text-content-muted',
            )}
        >
            {prettifyKeyToken(p)}
        </kbd>
    ));
}

// ─── Component ─────────────────────────────────────────────────────────

/**
 * Renders nothing until the provider says `isOpen`. Mounting as a
 * portal keeps the palette isolated from layout and always on top.
 */
const ENTITY_META: Record<
    EntityKind,
    { heading: string; icon: LucideIcon }
> = {
    control: { heading: 'Controls', icon: ShieldCheck },
    task: { heading: 'Tasks', icon: CheckSquare },
    policy: { heading: 'Policies', icon: FileText },
    evidence: { heading: 'Evidence', icon: Paperclip },
    framework: { heading: 'Frameworks', icon: Layers },
    asset: { heading: 'Assets', icon: Package },
    knowledge: { heading: 'Knowledge', icon: BookOpen },
};

const ENTITY_ORDER: EntityKind[] = [
    'control',
    'task',
    'policy',
    'evidence',
    'framework',
    'asset',
    'knowledge',
];

function groupByKind(
    results: EntitySearchResult[],
): Map<EntityKind, EntitySearchResult[]> {
    const grouped = new Map<EntityKind, EntitySearchResult[]>();
    for (const r of results) {
        const bucket = grouped.get(r.kind) ?? [];
        bucket.push(r);
        grouped.set(r.kind, bucket);
    }
    return grouped;
}

export function CommandPalette() {
    const t = useTranslations('commandPalette');
    const entityHeadings: Record<EntityKind, string> = {
        control: t('entControls'),
        task: t('entTasks'),
        policy: t('entPolicies'),
        evidence: t('entEvidence'),
        framework: t('entFrameworks'),
        asset: t('entAssets'),
        knowledge: t('entKnowledge'),
    };
    const { isOpen, close } = useCommandPalette();
    const shortcuts = useRegisteredShortcuts();
    const router = useRouter();
    const pathname = usePathname();
    const tenantSlug = tenantSlugFromPathname(pathname);

    const [query, setQuery] = useState('');
    const { loading, results, disabled: searchDisabled } = useEntitySearch(
        query,
        tenantSlug,
    );
    // ── Entity-type filter chips ──────────────────────────────────────
    // Ephemeral — not persisted across palette opens. Each fresh
    // open starts with no chips active (= all kinds visible).
    const [activeKinds, setActiveKinds] = useState<Set<SearchHitType>>(
        () => new Set(),
    );
    const handleToggleChip = useCallback((kind: SearchHitType) => {
        setActiveKinds((prev) => toggleKind(prev, kind));
    }, []);
    // EntitySearchResult exposes `.kind` (legacy adapter shape);
    // the helpers are generic over a kind extractor.
    const getKind = (r: EntitySearchResult): SearchHitType => r.kind;
    const filteredResults = useMemo(
        () => filterHitsByKind(results, activeKinds, getKind),
        [results, activeKinds],
    );
    const perKindCounts = useMemo(
        () => countHitsByKind(results, getKind),
        [results],
    );
    const grouped = groupByKind(filteredResults);
    const hasEntityResults = filteredResults.length > 0;

    // ── Recents (per-tenant, bounded, dedupe-on-touch) ────────────────
    // Storage key keyed on tenantSlug; useLocalStorage handles the
    // SSR-safe one-tick hydration. `useEntitySearch` already returns
    // `null` results when tenantSlug is null, so the recents UI just
    // hides itself in that case.
    const recentsKey = recentsStorageKey(tenantSlug ?? '__no-tenant__');
    const [recentsBlob, setRecentsBlob] = useLocalStorage(recentsKey, {
        version: 1,
        items: [] as RecentItem[],
    });
    const recents: RecentItem[] = useMemo(
        () => loadRecents(recentsBlob),
        [recentsBlob],
    );
    const showRecents = query.trim().length === 0 && tenantSlug !== null && recents.length > 0;
    const recordVisit = useCallback(
        (item: Omit<RecentItem, 'lastVisitedAt'>) => {
            setRecentsBlob(serializeRecents(addRecent(recents, item)));
        },
        [recents, setRecentsBlob],
    );

    // Navigation + action commands. When the user has started typing,
    // we fold the shortcut group away so the narrower, intent-driven
    // Navigation / Actions / entity-search stack owns the surface.
    const allCommands = usePaletteCommands(tenantSlug);
    const filteredCommands = filterPaletteCommands(allCommands, query);
    const navCommands = filteredCommands.filter((c) => c.group === 'Navigation');
    const actionCommands = filteredCommands.filter((c) => c.group === 'Actions');

    const showShortcuts = query.trim().length === 0;

    // Registry-derived lookup: palette command `label` → first
    // registered shortcut key whose description matches exactly. The
    // registry stays the single source of truth for the binding; this
    // map is metadata for render only, so the keycap is NEVER wrong
    // about what actually fires.
    const shortcutsByDescription = useMemo(() => {
        const map = new Map<string, string>();
        for (const s of shortcuts) {
            if (!s.description) continue;
            if (s.keys.length === 0) continue;
            if (!map.has(s.description)) map.set(s.description, s.keys[0]);
        }
        return map;
    }, [shortcuts]);
    const shortcutFor = useCallback(
        (label: string): string | undefined =>
            shortcutsByDescription.get(label),
        [shortcutsByDescription],
    );

    // The palette's own `mod+k` binding shouldn't clutter the list —
    // it's the invocation affordance, not a first-class command.
    // Also fold out any shortcut whose description matches a palette
    // command we're already rendering inline (we display its keycap
    // on the action row itself — listing it again in the shortcut
    // group would be noise).
    const allCommandLabels = useMemo(
        () => new Set(allCommands.map((c) => c.label)),
        [allCommands],
    );
    const listedShortcuts = shortcuts.filter(
        (s) =>
            s.description &&
            s.description !== 'Open command palette' &&
            !allCommandLabels.has(s.description),
    );

    const handleSelect = (href: string) => {
        close();
        // Reset the query so the next open starts fresh.
        setQuery('');
        router.push(href);
    };

    /**
     * Selection variant for ENTITY rows (search hits + recents).
     * Records the visit so it surfaces in the recents group on
     * subsequent opens. Static nav targets call `handleSelect`
     * directly — they don't pollute recents (the static commands
     * are already permanently visible).
     */
    const handleEntitySelect = (
        href: string,
        item: Omit<RecentItem, 'lastVisitedAt'>,
    ) => {
        recordVisit(item);
        handleSelect(href);
    };

    const handleAction = (perform: () => void) => {
        close();
        setQuery('');
        // Let the close animation kick before running the action so
        // a sign-out redirect doesn't race the portal teardown.
        queueMicrotask(() => perform());
    };

    // Reset the query AND the chip filter when the palette closes so
    // the next open starts clean. Covers the backdrop-click and
    // Escape paths that don't go through `handleSelect`.
    useEffect(() => {
        if (!isOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setQuery('');
            setActiveKinds(new Set());
        }
    }, [isOpen]);

    return (
        <Dialog.Root open={isOpen} onOpenChange={(next) => !next && close()}>
            <Dialog.Portal>
                <Dialog.Overlay
                    data-modal-overlay
                    className={cn(
                        'fixed inset-0 z-50',
                        'bg-bg-overlay backdrop-blur-sm',
                        'data-[state=open]:animate-fade-in',
                    )}
                />
                <Dialog.Content
                    aria-label={t('title')}
                    onOpenAutoFocus={(e) => {
                        // Radix focuses the first focusable child. cmdk's
                        // `Command.Input` is first in the tree and gets it
                        // by default. `preventDefault()` here would KEEP
                        // focus on the previously active element, so leave
                        // Radix's default behaviour in place.
                        e.stopPropagation();
                    }}
                    className={cn(
                        'fixed left-1/2 top-[20%] z-50 w-[92vw] max-w-[640px]',
                        '-translate-x-1/2',
                        'rounded-xl border border-border-default bg-bg-elevated shadow-2xl',
                        'text-content-emphasis',
                        'data-[state=open]:animate-fade-in',
                        'focus-visible:outline-none',
                    )}
                    data-command-palette
                >
                    <VisuallyHidden.Root>
                        <Dialog.Title>{t('title')}</Dialog.Title>
                        <Dialog.Description>
                            {t('description')}
                        </Dialog.Description>
                    </VisuallyHidden.Root>

                    <Command
                        loop
                        // Backend filters for controls/policies/
                        // evidence; client-side filtering happens in
                        // `useEntitySearch` for frameworks. cmdk's own
                        // fuzzy filter would double-filter away good
                        // matches, so disable it.
                        shouldFilter={false}
                        className="flex flex-col"
                        label={t('title')}
                    >
                        <div
                            className={cn(
                                'flex items-center gap-tight border-b border-border-subtle',
                                'px-4 py-3',
                            )}
                        >
                            <Search
                                className="size-4 shrink-0 text-content-muted"
                                aria-hidden="true"
                            />
                            <Command.Input
                                autoFocus
                                value={query}
                                onValueChange={setQuery}
                                placeholder={
                                    searchDisabled
                                        ? t('placeholderSignedOut')
                                        : t('placeholder')
                                }
                                className={cn(
                                    'flex-1 bg-transparent text-sm',
                                    'text-content-emphasis placeholder:text-content-subtle',
                                    'focus:outline-none',
                                )}
                                data-testid="command-palette-input"
                            />
                            <kbd
                                className={cn(
                                    'hidden shrink-0 items-center rounded border',
                                    'border-border-subtle bg-bg-muted px-1.5 py-0.5',
                                    'text-[10px] font-medium text-content-muted',
                                    'sm:inline-flex',
                                )}
                            >
                                {t('esc')}
                            </kbd>
                        </div>

                        {/* Filter chips — only visible when search is
                            active (non-empty query). Hides chip row on
                            the empty-state surface so static commands
                            + recents read clean.

                            Each chip toggles `activeKinds` (multi-
                            select). Empty active set means "all kinds
                            visible" — no separate "All" chip needed.
                            Counts are derived from the FULL pre-filter
                            result list so a user can see what they'd
                            unhide by toggling a chip back on. */}
                        {query.trim().length > 0 && (
                            <div
                                className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-4 py-2"
                                role="group"
                                aria-label={t('filterAria')}
                                data-testid="palette-filter-chips"
                            >
                                {(Object.keys(SEARCH_TYPE_DEFAULTS) as SearchHitType[]).map((kind) => {
                                    const count = perKindCounts[kind];
                                    const active = activeKinds.has(kind);
                                    return (
                                        <button
                                            key={kind}
                                            type="button"
                                            onClick={() => handleToggleChip(kind)}
                                            aria-pressed={active}
                                            data-chip-kind={kind}
                                            data-chip-active={active ? 'true' : 'false'}
                                            className={cn(
                                                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] border transition-colors',
                                                active
                                                    ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)] text-[var(--brand-default)]'
                                                    : 'border-border-subtle text-content-muted hover:text-content-emphasis hover:bg-bg-muted',
                                                count === 0 && !active && 'opacity-60',
                                            )}
                                        >
                                            <span className="capitalize">{SEARCH_TYPE_DEFAULTS[kind].category}</span>
                                            <span className="text-[10px] tabular-nums opacity-80">{count}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        <Command.List
                            className={cn(
                                'max-h-[min(60vh,420px)] overflow-y-auto',
                                'p-2',
                            )}
                            data-testid="command-palette-list"
                        >
                            <Command.Empty
                                className={cn(
                                    'py-10 text-center text-sm text-content-muted',
                                )}
                            >
                                {loading
                                    ? t('searching')
                                    : searchDisabled
                                      ? t('searchAfterSignin')
                                      : activeKinds.size > 0 && results.length > 0
                                        ? t('noMatchesInCategories')
                                        : t('noResults')}
                            </Command.Empty>

                            {/* Recents — visible only when the user
                                hasn't started typing AND has visited
                                at least one entity in this tenant
                                before. Clicking a recent re-records
                                it (move-to-top), so frequent targets
                                stay near the top organically. */}
                            {showRecents && (
                                <RecentsGroup
                                    items={recents}
                                    onSelect={handleEntitySelect}
                                />
                            )}

                            {navCommands.length > 0 && (
                                <CommandGroup
                                    heading={t('navigation')}
                                    items={navCommands}
                                    testIdPrefix="nav"
                                    onNavigate={handleSelect}
                                    onAction={handleAction}
                                    shortcutFor={shortcutFor}
                                />
                            )}

                            {actionCommands.length > 0 && (
                                <CommandGroup
                                    heading={t('actions')}
                                    items={actionCommands}
                                    testIdPrefix="action"
                                    onNavigate={handleSelect}
                                    onAction={handleAction}
                                    shortcutFor={shortcutFor}
                                />
                            )}

                            {hasEntityResults &&
                                ENTITY_ORDER.map((kind) => {
                                    const items = grouped.get(kind);
                                    if (!items || items.length === 0) return null;
                                    const meta = ENTITY_META[kind];
                                    return (
                                        <EntityGroup
                                            key={kind}
                                            heading={entityHeadings[kind]}
                                            Icon={meta.icon}
                                            items={items}
                                            onSelect={(href) => {
                                                // Find the source row so we can
                                                // record the recent. Items in this
                                                // group are guaranteed to share
                                                // the same kind; first match by
                                                // href is canonical.
                                                const row = items.find((i) => i.href === href);
                                                if (row) {
                                                    handleEntitySelect(href, {
                                                        type: row.kind,
                                                        id: row.id,
                                                        title: row.primary,
                                                        href: row.href,
                                                        iconKey: SEARCH_TYPE_DEFAULTS[row.kind].iconKey,
                                                    });
                                                } else {
                                                    handleSelect(href);
                                                }
                                            }}
                                        />
                                    );
                                })}

                            {/*
                             * Keyboard-shortcut discoverability: show
                             * only when the user hasn't started typing
                             * — keeps the search surface uncluttered.
                             */}
                            {showShortcuts && listedShortcuts.length > 0 && (
                                <ShortcutGroup
                                    heading={t('keyboardShortcuts')}
                                    items={listedShortcuts}
                                />
                            )}
                        </Command.List>
                    </Command>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function CommandGroup({
    heading,
    items,
    testIdPrefix,
    onNavigate,
    onAction,
    shortcutFor,
}: {
    heading: string;
    items: PaletteCommand[];
    testIdPrefix: string;
    onNavigate: (href: string) => void;
    onAction: (perform: () => void) => void;
    /**
     * Resolves a palette command's `label` → the first registered
     * shortcut key that advertises the same description, or
     * `undefined` if nothing is registered. Lets palette rows display
     * their keyboard affordance without duplicating the binding:
     * the registry remains the authoritative source, and the palette
     * only surfaces what's there.
     */
    shortcutFor: (label: string) => string | undefined;
}) {
    return (
        <Command.Group
            heading={heading}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
        >
            {items.map((c) => {
                const Icon = c.icon;
                const shortcutKey = shortcutFor(c.label);
                return (
                    <Command.Item
                        key={c.id}
                        value={c.id}
                        onSelect={() => {
                            if (c.href) onNavigate(c.href);
                            else if (c.perform) onAction(c.perform);
                        }}
                        className={cn(
                            'flex cursor-pointer items-center gap-compact rounded-md px-2 py-2 text-sm',
                            'text-content-default',
                            'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                        )}
                        data-testid={`command-palette-${testIdPrefix}-${c.id}`}
                        data-href={c.href}
                    >
                        <Icon
                            aria-hidden="true"
                            className="size-4 shrink-0 text-content-muted"
                        />
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {shortcutKey && (
                            <span
                                className="flex shrink-0 items-center"
                                data-testid={`command-palette-${testIdPrefix}-${c.id}-shortcut`}
                            >
                                {renderShortcut(shortcutKey)}
                            </span>
                        )}
                    </Command.Item>
                );
            })}
        </Command.Group>
    );
}

function EntityGroup({
    heading,
    Icon,
    items,
    onSelect,
}: {
    heading: string;
    Icon: LucideIcon;
    items: EntitySearchResult[];
    onSelect: (href: string) => void;
}) {
    return (
        <Command.Group
            heading={heading}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
        >
            {items.map((r) => (
                <Command.Item
                    key={`${r.kind}:${r.id}`}
                    // The value must be unique per item; include kind to
                    // avoid collisions across groups. cmdk's selection
                    // machinery uses this to drive keyboard navigation.
                    value={`${r.kind}:${r.id}:${r.primary}`}
                    onSelect={() => onSelect(r.href)}
                    className={cn(
                        'flex cursor-pointer items-center gap-compact rounded-md px-2 py-2 text-sm',
                        'text-content-default',
                        'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                    )}
                    data-testid={`command-palette-result-${r.kind}`}
                    data-href={r.href}
                >
                    <Icon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-content-muted"
                    />
                    <span className="min-w-0 flex-1 truncate">{r.primary}</span>
                    {r.secondary && (
                        <span className="shrink-0 text-xs text-content-muted">
                            {r.secondary}
                        </span>
                    )}
                    {r.badge && (
                        <span
                            className={cn(
                                'shrink-0 rounded border border-border-subtle bg-bg-muted',
                                'px-1.5 py-0.5 text-[10px] font-medium uppercase',
                                'tracking-wider text-content-muted',
                            )}
                        >
                            {r.badge}
                        </span>
                    )}
                </Command.Item>
            ))}
        </Command.Group>
    );
}

function ShortcutGroup({
    heading,
    items,
}: {
    heading: string;
    items: RegisteredShortcut[];
}) {
    return (
        <Command.Group
            heading={heading}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
        >
            {items.map((s) => (
                <Command.Item
                    key={s.id}
                    value={`${s.description ?? ''} ${s.keys.join(' ')}`}
                    className={cn(
                        'flex cursor-default items-center justify-between gap-compact',
                        'rounded-md px-2 py-2 text-sm',
                        'text-content-default',
                        'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                    )}
                    data-testid="command-palette-shortcut"
                >
                    <span className="truncate">{s.description}</span>
                    <span className="flex items-center">
                        {s.keys.slice(0, 1).map((k) => (
                            <span key={k} className="flex items-center">
                                {renderShortcut(k)}
                            </span>
                        ))}
                    </span>
                </Command.Item>
            ))}
        </Command.Group>
    );
}

// ─── Recents group ────────────────────────────────────────────────────

function RecentsGroup({
    items,
    onSelect,
}: {
    items: ReadonlyArray<RecentItem>;
    onSelect: (
        href: string,
        item: Omit<RecentItem, 'lastVisitedAt'>,
    ) => void;
}) {
    const t = useTranslations('commandPalette');
    return (
        <Command.Group
            heading={t('recent')}
            className={cn(
                '[&_[cmdk-group-heading]]:px-2',
                '[&_[cmdk-group-heading]]:py-1.5',
                '[&_[cmdk-group-heading]]:text-xs',
                '[&_[cmdk-group-heading]]:font-medium',
                '[&_[cmdk-group-heading]]:uppercase',
                '[&_[cmdk-group-heading]]:tracking-wider',
                '[&_[cmdk-group-heading]]:text-content-subtle',
            )}
            data-testid="palette-recents-group"
        >
            {items.slice(0, MAX_RECENTS).map((item) => (
                <Command.Item
                    key={`${item.type}:${item.id}`}
                    value={`${item.title} ${item.type}`}
                    onSelect={() =>
                        onSelect(item.href, {
                            type: item.type,
                            id: item.id,
                            title: item.title,
                            href: item.href,
                            iconKey: item.iconKey,
                        })
                    }
                    data-testid="palette-recent-item"
                    data-recent-type={item.type}
                    className={cn(
                        'flex cursor-pointer items-center justify-between gap-compact',
                        'rounded-md px-2 py-2 text-sm',
                        'text-content-default',
                        'data-[selected=true]:bg-bg-muted data-[selected=true]:text-content-emphasis',
                    )}
                >
                    <span className="truncate">{item.title}</span>
                    <span className="text-[10px] uppercase tracking-wider text-content-subtle">
                        {SEARCH_TYPE_DEFAULTS[item.type].category}
                    </span>
                </Command.Item>
            ))}
        </Command.Group>
    );
}

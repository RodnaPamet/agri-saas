/**
 * Roadmap-12 PR-10 — rendered tests for `<NavItem>`.
 *
 * The bundle ratchet at `tests/guards/nav-item-bundle-discipline.test.ts`
 * verifies the named-const recipes exist at the source level. THIS
 * test is the runtime consumer: it mounts `<NavItem>` in each
 * production state and asserts the consts flow into the rendered
 * DOM end-to-end.
 *
 * Three states covered:
 *
 *   1. **Default** (active=false, no badge). The link should carry
 *      the BASE composition + DEFAULT recipe. Icon renders at 18×18
 *      with the canonical class. No badge in the tree.
 *
 *   2. **Active** (active=true, no badge). Link carries BASE +
 *      ACTIVE recipe (four conviction tokens: emphasis text +
 *      brand-subtle bg + before:opacity-100 + font-medium).
 *
 *   3. **With badge** (badge=5). The StatusBadge renders with the
 *      five-token NAV_ITEM_BADGE recipe applied.
 *
 * No axe-core test — `<NavItem>` is rendered inside a `<nav>` /
 * sidebar at the AppShell level, which is the right axe boundary
 * for the role landmark. Asserting axe on the bare link would fail
 * "all-elements-must-be-inside-landmark" without giving us useful
 * signal.
 */

import { render, screen } from '@testing-library/react';
import { Settings } from 'lucide-react';
import * as React from 'react';

import {
    NavItem,
    NAV_ITEM_BASE,
    NAV_ITEM_DEFAULT,
    NAV_ITEM_ACTIVE,
    NAV_ITEM_BADGE,
    NAV_ITEM_ICON_CLASS,
} from '@/components/layout/nav-item';

describe('<NavItem>', () => {
    describe('default state (active=false)', () => {
        it('renders the link with BASE + DEFAULT class compositions', () => {
            render(
                <NavItem
                    href="/t/foo/practices"
                    icon={Settings}
                    label="Practices"
                    active={false}
                />,
            );
            const link = screen.getByRole('link', { name: 'Practices' });
            // BASE tokens are present (sample three load-bearing pieces).
            expect(link.className).toContain('min-h-[44px]');
            expect(link.className).toContain('rounded-lg');
            expect(link.className).toContain('focus-visible:ring-2');
            // DEFAULT recipe is present.
            expect(link.className).toContain('text-content-muted');
            expect(link.className).toContain('hover:text-content-emphasis');
            // 2026-05-19 — hover band reveal retired. The brand
            // capsule still ships in BASE (for the active row), but
            // the default recipe no longer fades it in / animates
            // it / reaches it on hover. The remaining hover effects
            // (gloss, bevel-shadow, liquid sweep) carry the signal.
            expect(link.className).not.toContain('hover:before:opacity-100');
            expect(link.className).not.toContain(
                'hover:before:animate-nav-band-alive',
            );
            expect(link.className).not.toContain('hover:before:top-1');
            expect(link.className).not.toContain('hover:before:w-[4px]');
            expect(link.className).toContain('hover:after:opacity-100');
            expect(link.className).toContain(
                'hover:shadow-[var(--nav-bevel-shadow)]',
            );
            // R13-PR8 — press feedback present in base.
            expect(link.className).toContain('active:translate-y-px');
            expect(link.className).toContain(
                'motion-reduce:active:translate-y-0',
            );
            // R13-PR6 — gloss `::after` plumbing.
            expect(link.className).toContain(
                'after:bg-[var(--nav-gloss-highlight)]',
            );
            // ACTIVE tokens are absent.
            expect(link.className).not.toContain('bg-[var(--brand-subtle)]');
            expect(link.className).not.toContain('font-medium');
            expect(link.className).not.toContain(
                'text-[var(--brand-default)]',
            );
        });

        it('renders the icon with the canonical 18×18 + flex-shrink-0', () => {
            render(
                <NavItem
                    href="/t/foo/practices"
                    icon={Settings}
                    label="Practices"
                    active={false}
                />,
            );
            const link = screen.getByRole('link', { name: 'Practices' });
            const icon = link.querySelector('svg');
            expect(icon).not.toBeNull();
            // The icon's class string EQUALS NAV_ITEM_ICON_CLASS — no
            // hand-rolled override.
            // Lucide prepends its own `lucide lucide-<name>` prefix to
            // the SVG element. The recipe is appended after that, so
            // the className CONTAINS the full NAV_ITEM_ICON_CLASS
            // string but doesn't equal it.
            expect(icon!.getAttribute('class')).toContain(NAV_ITEM_ICON_CLASS);
            // Icon is decorative — label is the accessible name.
            expect(icon).toHaveAttribute('aria-hidden', 'true');
        });

        it('does not render a badge when none is provided', () => {
            const { container } = render(
                <NavItem
                    href="/t/foo/practices"
                    icon={Settings}
                    label="Practices"
                    active={false}
                />,
            );
            // No tabular-nums element (the badge carries it).
            expect(container.querySelector('.tabular-nums')).toBeNull();
        });
    });

    describe('active state (active=true) — R12-PR6 + R13 evolution', () => {
        it('renders the link with BASE + ACTIVE class compositions', () => {
            render(
                <NavItem
                    href="/t/foo/practices"
                    icon={Settings}
                    label="Practices"
                    active={true}
                />,
            );
            const link = screen.getByRole('link', { name: 'Practices' });
            // Active conviction tokens — R13-evolved vocabulary.
            // Text colour (R13-PR5): brand-default (yellow/orange).
            expect(link.className).toContain(
                'text-[var(--brand-default)]',
            );
            // Wash (R13-PR11): radial gradient from secondary-subtle.
            expect(link.className).toMatch(/bg-\[radial-gradient\(/);
            expect(link.className).toContain(
                'var(--brand-secondary-subtle)',
            );
            // Band held visible (R12-PR6 preserved).
            expect(link.className).toContain('before:opacity-100');
            // Weight bump (R12-PR6 preserved).
            expect(link.className).toContain('font-medium');
            // Band overrides — R13-PR4 originally locked navy
            // (brand-secondary) stops via utility classes;
            // 2026-05-13 v1 swapped to `--bg-page` utility
            // overrides; same-day v2 moved to a full
            // `before:bg-[...]!` arbitrary-value override because
            // the utility `from/via/to` overrides don't compose
            // against the BASE recipe's arbitrary `before:bg-[...]`
            // value. The rendered class string just needs the
            // page-bg token present in the band's bg-image stack.
            const bandHasBgPage = link.className.includes('var(--bg-page)');
            const bandStopSecondary = link.className.includes(
                'before:from-[var(--brand-secondary-default)]!',
            );
            expect(bandHasBgPage || bandStopSecondary).toBe(true);
            expect(link.className).toContain(
                'before:shadow-[var(--nav-band-glow-active)]!',
            );
            // Reach geometry (R13-PR9).
            expect(link.className).toContain('before:top-1!');
            expect(link.className).toContain('before:w-[4px]!');
            // Gloss + bevel held visible (R13-PR6 + PR-7). R15-PR9
            // stacked an outer brand-secondary aura ahead of the
            // bevel inside one multi-shadow value, so the bevel
            // token may sit inside a comma-separated stack rather
            // than as the sole shadow value.
            expect(link.className).toContain('after:opacity-100');
            expect(link.className).toContain('var(--nav-bevel-shadow)');
            // Band shimmer animation un-gated (R13-PR3). R15-PR4
            // broadened the active animation utility from the
            // single-track `nav-band-shimmer` to the composed
            // `nav-band-active-alive` (starburst + reveal +
            // shimmer + halo-breath); the composed entry still
            // embeds the shimmer track.
            expect(link.className).toContain(
                'before:animate-nav-band-active-alive',
            );
            // BASE is still present.
            expect(link.className).toContain('min-h-[44px]');
            // DEFAULT-specific hover tokens are absent (we're active).
            expect(link.className).not.toContain('text-content-muted');
            expect(link.className).not.toContain(
                'hover:text-content-emphasis',
            );
        });

        it('uses the same canonical icon class as the default state', () => {
            render(
                <NavItem
                    href="/t/foo/practices"
                    icon={Settings}
                    label="Practices"
                    active={true}
                />,
            );
            const link = screen.getByRole('link', { name: 'Practices' });
            const icon = link.querySelector('svg');
            // Lucide prepends its own `lucide lucide-<name>` prefix to
            // the SVG element. The recipe is appended after that, so
            // the className CONTAINS the full NAV_ITEM_ICON_CLASS
            // string but doesn't equal it.
            expect(icon!.getAttribute('class')).toContain(NAV_ITEM_ICON_CLASS);
        });
    });

    describe('badge state (badge provided)', () => {
        it('renders a badge carrying NAV_ITEM_BADGE class string', () => {
            const { container } = render(
                <NavItem
                    href="/t/foo/calendar"
                    icon={Settings}
                    label="Calendar"
                    active={false}
                    badge={5}
                />,
            );
            // The badge's outermost element carries every NAV_ITEM_BADGE
            // token. Five tokens to lock.
            const badge = container.querySelector('.tabular-nums');
            expect(badge).not.toBeNull();
            const cls = badge!.className;
            expect(cls).toContain('ml-auto');
            expect(cls).toContain('tabular-nums');
            expect(cls).toContain('flex-shrink-0');
            expect(cls).toContain('animate-in');
            expect(cls).toContain('fade-in');
            expect(cls).toMatch(/\bduration-\d+\b/);
            // The badge content is the count.
            expect(badge!.textContent).toBe('5');
        });

        it('renders the badge even when active=true (badge is orthogonal to state)', () => {
            const { container } = render(
                <NavItem
                    href="/t/foo/calendar"
                    icon={Settings}
                    label="Calendar"
                    active={true}
                    badge={12}
                />,
            );
            const badge = container.querySelector('.tabular-nums');
            expect(badge).not.toBeNull();
            expect(badge!.textContent).toBe('12');
        });

        it('renders zero as a badge (badge != null check, not truthy check)', () => {
            // A badge with value `0` is legitimate ("0 open issues").
            // The conditional render uses `badge != null` so this
            // should appear. Lock the semantic.
            const { container } = render(
                <NavItem
                    href="/t/foo/issues"
                    icon={Settings}
                    label="Issues"
                    active={false}
                    badge={0}
                />,
            );
            const badge = container.querySelector('.tabular-nums');
            expect(badge).not.toBeNull();
            expect(badge!.textContent).toBe('0');
        });
    });

    describe('the exported consts are the source of truth', () => {
        // Sanity: confirm the imports resolved to non-empty strings.
        // If a future export rename slips through, this test will
        // catch it without needing to wait on the bundle ratchet.
        it('NAV_ITEM_BASE is a non-empty string', () => {
            expect(typeof NAV_ITEM_BASE).toBe('string');
            expect(NAV_ITEM_BASE.length).toBeGreaterThan(0);
        });
        it('NAV_ITEM_DEFAULT is a non-empty string', () => {
            expect(typeof NAV_ITEM_DEFAULT).toBe('string');
            expect(NAV_ITEM_DEFAULT.length).toBeGreaterThan(0);
        });
        it('NAV_ITEM_ACTIVE is a non-empty string', () => {
            expect(typeof NAV_ITEM_ACTIVE).toBe('string');
            expect(NAV_ITEM_ACTIVE.length).toBeGreaterThan(0);
        });
        it('NAV_ITEM_BADGE is a non-empty string', () => {
            expect(typeof NAV_ITEM_BADGE).toBe('string');
            expect(NAV_ITEM_BADGE.length).toBeGreaterThan(0);
        });
        it('NAV_ITEM_ICON_CLASS is a non-empty string', () => {
            expect(typeof NAV_ITEM_ICON_CLASS).toBe('string');
            expect(NAV_ITEM_ICON_CLASS.length).toBeGreaterThan(0);
        });
    });
});

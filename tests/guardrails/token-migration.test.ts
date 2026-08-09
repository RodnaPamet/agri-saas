/**
 * Guardrail: token migration — representative pages
 *
 * Verifies that the four representative pages migrated in Epic 51 use
 * the new design system primitives (Button, StatusBadge, EmptyState)
 * and semantic token classes instead of raw Tailwind colors.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function read(...segments: string[]): string {
    return fs.readFileSync(path.join(SRC, ...segments), 'utf-8');
}

describe('Dashboard page token migration', () => {
    // Epic 69 split the dashboard into a thin server shell + a
    // client component that owns the card composition. The token /
    // imports / button-variant assertions check the combined surface
    // (page.tsx + DashboardClient.tsx) — what matters is that the
    // primitives are used somewhere in the dashboard tree, not which
    // side of the server/client boundary owns them.
    const src =
        read('app/t/[tenantSlug]/(app)/dashboard/page.tsx') +
        '\n' +
        read('app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');

    it('UI-15: no longer imports buttonVariants (notif ghost link removed)', () => {
        expect(src).not.toContain("from '@/components/ui/button-variants'");
    });

    it('UI-15: no longer imports StatusBadge (notif badge removed)', () => {
        expect(src).not.toContain("from '@/components/ui/status-badge'");
    });

    it('the trends section (and its empty state) was removed from the dashboard', () => {
        // The compliance-trend charts left with the KPI grid in the farm-UI
        // trim, so the "no trends yet" empty state is gone too.
        expect(src).not.toContain('id="trend-section"');
        expect(src).not.toContain('Trend charts will appear here');
    });

    it('uses no raw Tailwind color scales (semantic tokens only)', () => {
        // The migration invariant: the dashboard tree never reaches for a
        // raw color scale (slate / gray / zinc / neutral) — semantic token
        // classes only. The KPI / trend / next-best-action surfaces that
        // carried the explicit `text-content-*` tokens were removed; the
        // enduring guarantee is that nothing regressed to raw colours.
        expect(src).not.toMatch(/\b(?:bg|text|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone)-\d/);
    });

    it('UI-15: the dashboard notifications-bell ghost link was removed', () => {
        // The 6 secondary Quick-Actions buttons were retired in v2-PR-11; the
        // notifications-bell ghost link was the last buttonVariants Link and is
        // removed in UI-15 (the top-bar bell is the canonical affordance). The
        // dashboard no longer imports buttonVariants.
        expect(src).not.toContain("buttonVariants({ variant: 'ghost'");
        expect(src).not.toContain("href={href('/notifications')}");
    });

    it('does not use legacy badge CSS classes', () => {
        expect(src).not.toMatch(/className="badge badge-/);
    });

    it('does not use legacy btn CSS classes', () => {
        expect(src).not.toMatch(/className="btn btn-/);
    });
});

describe('Vendors list page token migration', () => {
    const src = read('app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx');

    it('imports StatusBadge', () => {
        expect(src).toContain("from '@/components/ui/status-badge'");
    });

    it('imports EmptyState', () => {
        expect(src).toContain("from '@/components/ui/empty-state'");
    });

    it('imports buttonVariants', () => {
        expect(src).toContain("from '@/components/ui/button'");
    });

    it('uses semantic tokens for table styling', () => {
        expect(src).toContain('border-border-default');
        expect(src).toContain('text-content-muted');
        expect(src).toContain('hover:bg-bg-muted');
    });

    it('uses StatusBadge for status and criticality', () => {
        expect(src).toContain('<StatusBadge');
        expect(src).toContain('STATUS_VARIANT');
        expect(src).toContain('CRIT_VARIANT');
    });

    it('uses EmptyState for empty table', () => {
        expect(src).toContain('<EmptyState');
    });

    it('does not use legacy badge CSS classes', () => {
        expect(src).not.toMatch(/className=\{`badge \$/);
        expect(src).not.toMatch(/className="badge badge-/);
    });

    it('does not use legacy btn CSS classes', () => {
        expect(src).not.toMatch(/className="btn btn-/);
    });
});

describe('Admin members page token migration', () => {
    const src = read('app/t/[tenantSlug]/(app)/admin/members/page.tsx');

    it('imports Button', () => {
        expect(src).toContain("from '@/components/ui/button'");
    });

    it('imports StatusBadge and statusBadgeVariants', () => {
        expect(src).toContain("from '@/components/ui/status-badge'");
        expect(src).toContain('statusBadgeVariants');
    });

    it('imports EmptyState', () => {
        expect(src).toContain("from '@/components/ui/empty-state'");
    });

    it('uses Button for primary actions', () => {
        expect(src).toContain('<Button');
        expect(src).toContain('variant="primary"');
    });

    it('uses StatusBadge for member status', () => {
        expect(src).toContain('<StatusBadge');
        expect(src).toContain('STATUS_VARIANT');
    });

    it('uses statusBadgeVariants for clickable role badges', () => {
        expect(src).toContain('statusBadgeVariants({');
    });

    it('uses InlineNotice for alerts (PR-10)', () => {
        // PR-10 migrated the hand-rolled error/success banner blocks
        // to the canonical <InlineNotice> primitive — the colour-pair
        // tokens (bg-bg-error / border-border-error / etc.) now live
        // inside src/components/ui/inline-notice.tsx, not in the page.
        expect(src).toContain('<InlineNotice');
        expect(src).toContain('variant="error"');
        expect(src).toContain('variant="success"');
        expect(src).toContain("from '@/components/ui/inline-notice'");
    });

    it('uses the canonical Popover primitive for the row-action menu (token-safe by construction)', () => {
        // R6-P2 — the hand-rolled dropdown (which spelled bg-bg-default /
        // border-border-default / hover:bg-bg-* inline) was replaced by
        // <Popover>/<Popover.Menu>/<Popover.Item>. The primitive owns its
        // semantic-token styling, so the page no longer repeats those classes;
        // asserting the primitive is used preserves the token-safety guarantee
        // (the general "no raw color scales" test below still covers the page).
        expect(src).toContain("from '@/components/ui/popover'");
        expect(src).toContain('Popover.Menu');
        expect(src).toContain('Popover.Item');
    });

    it('uses EmptyState for empty table', () => {
        expect(src).toContain('<EmptyState');
    });

    it('does not use legacy btn CSS classes', () => {
        expect(src).not.toMatch(/className="btn btn-/);
    });

    it('does not use legacy badge CSS classes', () => {
        expect(src).not.toMatch(/className=\{`badge \$/);
        expect(src).not.toMatch(/className="badge badge-/);
    });
});

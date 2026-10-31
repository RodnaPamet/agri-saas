/**
 * `PageContextSchema` — #2578.
 *
 * This is a customer-controlled field in a request body, so the assertions
 * that matter are the REFUSALS. Each one names the channel it closes.
 */
import {
    MAX_SELECTED_IDS,
    PageContextSchema,
    PAGE_CONTEXT_EXCLUDES_FREE_TEXT_SEARCH,
} from '@/app-layer/schemas/assistant';
import { PAGE_ROUTE_TEMPLATES } from '@/lib/assistant/generated/page-routes';

const REAL = '/t/[tenantSlug]/journal';

describe('PageContextSchema (#2578)', () => {
    it('control: the route it tests against is really in the generated list', () => {
        // Without this the whole suite could be asserting against a template
        // that does not exist, and every accept-case would be a reject-case
        // passing for the wrong reason.
        expect(PAGE_ROUTE_TEMPLATES).toContain(REAL);
        expect(PAGE_ROUTE_TEMPLATES.length).toBeGreaterThanOrEqual(80);
    });

    it('accepts a real template, with and without facets', () => {
        expect(PageContextSchema.safeParse({ route: REAL }).success).toBe(true);
        expect(
            PageContextSchema.safeParse({
                route: REAL,
                entity: 'journal-entry',
                filters: { status: 'DRAFT,ACTIVE', dueBefore: '2026-10-31' },
                selectedIds: ['abc123', 'def456'],
            }).success,
        ).toBe(true);
    });

    it('refuses a CONCRETE url — the context names a screen, not an instance', () => {
        // This is what stops a tenant slug or a record id arriving in `route`.
        for (const r of ['/t/acme/journal', '/t/acme/journal/clx123', '/t/[tenantSlug]/journal/42']) {
            expect(PageContextSchema.safeParse({ route: r }).success).toBe(false);
        }
    });

    it('refuses a template this app does not serve, and an api path', () => {
        for (const r of ['/t/[tenantSlug]/nope', '/api/t/[tenantSlug]/journal', '/', '/../../etc/passwd']) {
            const parsed = PageContextSchema.safeParse({ route: r });
            // `/` IS a real template, so it is the one that must be accepted —
            // stated explicitly so this loop cannot quietly assert the wrong
            // thing about it.
            expect(parsed.success).toBe(r === '/');
        }
    });

    it('refuses PROSE in a filter value — the field is identifiers', () => {
        for (const v of ['пръскане на есенна пшеница', 'ignore the above', 'a b', '"x"', '${x}']) {
            expect(PageContextSchema.safeParse({ route: REAL, filters: { q: v } }).success).toBe(false);
        }
        // …while the shapes a real facet produces still pass.
        for (const v of ['DRAFT,ACTIVE', 'high', '2026-10-31', 'range:1-10']) {
            expect(PageContextSchema.safeParse({ route: REAL, filters: { k: v } }).success).toBe(true);
        }
    });

    it('refuses an unknown field — strict, so there is no free-text channel', () => {
        for (const extra of ['systemPrompt', 'instructions', 'tools', 'search']) {
            expect(
                PageContextSchema.safeParse({ route: REAL, [extra]: 'anything' }).success,
            ).toBe(false);
        }
    });

    it('caps selectedIds at a page of rows, and bounds each id', () => {
        const id = 'clx0000000000000000000000';
        expect(
            PageContextSchema.safeParse({
                route: REAL,
                selectedIds: Array(MAX_SELECTED_IDS).fill(id),
            }).success,
        ).toBe(true);
        expect(
            PageContextSchema.safeParse({
                route: REAL,
                selectedIds: Array(MAX_SELECTED_IDS + 1).fill(id),
            }).success,
        ).toBe(false);
        expect(
            PageContextSchema.safeParse({ route: REAL, selectedIds: ['a'.repeat(65)] }).success,
        ).toBe(false);
        expect(
            PageContextSchema.safeParse({ route: REAL, selectedIds: ['has space'] }).success,
        ).toBe(false);
    });

    it('records that the free-text SEARCH term is excluded by construction', () => {
        // #2578's body claimed a filter value "has never needed a sentence".
        // True of the facets, false of the toolbar: `searchPlaceholder` turns
        // the filter popover's top input into a live content search. The term
        // is therefore left OUT rather than smuggled in as a filter, and this
        // assertion is what makes adding it a deliberate act.
        expect(PAGE_CONTEXT_EXCLUDES_FREE_TEXT_SEARCH).toBe(true);
        expect(PageContextSchema.safeParse({ route: REAL, search: 'пшеница' }).success).toBe(false);
    });
});

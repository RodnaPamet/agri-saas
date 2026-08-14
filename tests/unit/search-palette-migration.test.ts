/**
 * Structural ratchet for the command-palette migration to the
 * unified search endpoint.
 *
 * The original Epic 57 hook fanned out to 5 per-entity routes
 * (`/practices`, `/risks`, `/policies`, `/evidence`,
 * `/frameworks` — four of which no longer exist) and merged the
 * results client-side. The
 * migration consolidates that into ONE round-trip to
 * `/api/t/<slug>/search?q=`.
 *
 * A future "simplify" PR could quietly re-introduce the
 * per-entity fan-out — the regression would be silent (the
 * palette would still render results) but would re-fragment the
 * search architecture and re-introduce the ranking-drift
 * problem the unified endpoint exists to solve.
 *
 * This test locks the structural shape so that can't happen
 * without a deliberate diff against this file.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SearchHitType } from '@/lib/search/types';
import { __SEARCHABLE_TYPES__ } from '@/app-layer/usecases/search';

const HOOK = path.resolve(
    __dirname,
    '../../src/components/command-palette/use-entity-search.ts',
);
const ROUTE = path.resolve(
    __dirname,
    '../../src/app/api/t/[tenantSlug]/search/route.ts',
);
const USECASE = path.resolve(
    __dirname,
    '../../src/app-layer/usecases/search.ts',
);
const TYPES = path.resolve(__dirname, '../../src/lib/search/types.ts');

function read(p: string): string {
    return fs.readFileSync(p, 'utf-8');
}

describe('Command palette — uses the unified search endpoint', () => {
    const hook = read(HOOK);

    it('issues exactly ONE fetch per query (single-endpoint contract)', () => {
        // The unified hook calls fetch once. Anything > 1 means
        // someone is fanning out again.
        const fetchCalls = hook.match(/\bfetch\(/g) ?? [];
        expect(fetchCalls.length).toBe(1);
    });

    it('targets the unified /search route', () => {
        expect(hook).toMatch(/\/api\/t\/\$\{[^}]*\}\/search\?q=/);
    });

    it('does not touch any of the legacy per-entity routes', () => {
        // Catches the explicit mistake where someone re-adds a
        // call to `/practices`, `/risks`, etc. The unified endpoint
        // is the contract; per-entity hits are forbidden inside
        // this hook.
        expect(hook).not.toMatch(/\/api\/t\/[^"'`]*\/(practices|risks|policies|evidence|frameworks)\?/);
    });

    it('imports the typed SearchResponse from the search lib', () => {
        // The hook should consume the typed contract directly,
        // not re-derive a payload shape.
        expect(hook).toMatch(/from\s*['"]@\/lib\/search\/types['"]/);
        expect(hook).toMatch(/SearchResponse\b/);
    });

    it('keeps the externally-visible hook contract stable', () => {
        // Palette consumers depend on these named exports — the
        // migration is purely an implementation swap.
        expect(hook).toMatch(/export function useEntitySearch\b/);
        expect(hook).toMatch(/export function tenantSlugFromPathname\b/);
        expect(hook).toMatch(/export type EntityKind\b/);
        expect(hook).toMatch(/export interface EntitySearchResult\b/);
    });
});

describe('Command palette — recents + filter chips wiring', () => {
    const PALETTE = path.resolve(
        __dirname,
        '../../src/components/command-palette/command-palette.tsx',
    );
    const palette = read(PALETTE);

    it('imports the recents helpers + storage key from the palette lib', () => {
        expect(palette).toMatch(/from\s*'@\/lib\/palette\/recents'/);
        expect(palette).toMatch(/recentsStorageKey/);
        expect(palette).toMatch(/addRecent/);
    });

    it('imports the filter helpers from the palette lib', () => {
        expect(palette).toMatch(/from\s*'@\/lib\/palette\/filter'/);
        expect(palette).toMatch(/filterHitsByKind/);
        expect(palette).toMatch(/countHitsByKind/);
        expect(palette).toMatch(/toggleKind/);
    });

    it('persists recents via the project-standard useLocalStorage hook', () => {
        // Avoids reinventing SSR-safe storage; useLocalStorage
        // already handles the one-tick hydration delay correctly.
        expect(palette).toMatch(/useLocalStorage\(/);
    });

    it('renders the chip row only when a search query is active', () => {
        // Hides on the empty-state surface so static commands +
        // recents read clean.
        expect(palette).toMatch(/data-testid="palette-filter-chips"/);
        expect(palette).toMatch(/query\.trim\(\)\.length\s*>\s*0/);
    });

    it('renders the Recents group only when query is empty + tenant + items', () => {
        expect(palette).toMatch(/data-testid="palette-recents-group"/);
        expect(palette).toMatch(/showRecents/);
    });

    it('records a visit when an entity row is selected', () => {
        // The recordVisit closure runs on every entity-row click,
        // moving the picked item to the head of the recents list.
        expect(palette).toMatch(/recordVisit\b/);
        expect(palette).toMatch(/handleEntitySelect\b/);
    });

    it('resets the chip filter when the palette closes', () => {
        // Each open starts fresh — chip selection is ephemeral.
        // Lock that intent so it can't quietly become persistent.
        expect(palette).toMatch(/setActiveKinds\(new Set\(\)\)/);
    });
});

describe('Search route + usecase — structural shape', () => {
    const route = read(ROUTE);
    const usecase = read(USECASE);
    const types = read(TYPES);

    it('route delegates to getUnifiedSearch (no inline DB queries)', () => {
        expect(route).toMatch(/getUnifiedSearch\b/);
        expect(route).not.toMatch(/\bprisma\./);
    });

    it('usecase scopes tenant reads via runInTenantContext', () => {
        expect(usecase).toMatch(/runInTenantContext\b/);
    });

    it('usecase enforces a role check before searching', () => {
        expect(usecase).toMatch(/!ctx\.role/);
        expect(usecase).toMatch(/forbidden\(/);
    });

    it('searches every canonical entity type', () => {
        // DERIVED from the union, not hand-listed. The previous version
        // spelled out five `findMany` calls and therefore drifted: it was
        // still demanding db.practice / db.policy / prisma.framework long
        // after those models were on the teardown KILL list, so the test
        // that exists to catch an accidental DROP would instead have
        // blocked a deliberate one.
        //
        // `Record<SearchHitType, …>` is the load-bearing part: adding a
        // member to the union fails to COMPILE here until its query is
        // named, and removing one forces this map to shrink in the same
        // diff. The mapping cannot be inferred (knowledge → knowledgeArticle),
        // which is why it is spelled out rather than generated.
        const QUERY_FOR_TYPE: Record<SearchHitType, RegExp> = {
            evidence: /db\.evidence\.findMany/,
            asset: /db\.asset\.findMany/,
            task: /db\.task\.findMany/,
            knowledge: /db\.knowledgeArticle\.findMany/,
        };
        for (const [type, re] of Object.entries(QUERY_FOR_TYPE)) {
            expect({ type, found: re.test(usecase) }).toEqual({ type, found: true });
        }
        // Totality is compile-time; this guards against the map being
        // emptied out to make the loop vacuous.
        expect(Object.keys(QUERY_FOR_TYPE).length).toBe(__SEARCHABLE_TYPES__.length);
    });

    it('contract carries one mixed-entity result type, not a union', () => {
        expect(types).toMatch(/export interface SearchHit\b/);
        expect(types).toMatch(/export interface SearchResponse\b/);
        expect(types).toMatch(/SearchHitType\b/);
    });

    it('contract carries explicit per-type metadata for the renderer', () => {
        expect(types).toMatch(/SEARCH_TYPE_DEFAULTS\b/);
    });

    it('default per-type limit is documented + enforced as a constant', () => {
        expect(types).toMatch(/DEFAULT_PER_TYPE_LIMIT\b/);
    });
});

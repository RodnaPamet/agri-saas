/**
 * Location response-projection ratchet.
 *
 * `GET /locations/{id}` shipped 21 raw Prisma columns where the DTO
 * documented 14. Nothing caught it because `LocationListItemDTOSchema` was
 * `.passthrough()` — extra fields violated nothing — so five internal
 * lifecycle columns (`createdByUserId`, `isSampleData`, `deletedAt`,
 * `deletedByUserId`, `retentionUntil`, three of them retention/erasure
 * bookkeeping) went out on every locations read.
 *
 * Two invariants:
 *   1. The projector and the documented schema name the SAME fields, so
 *      they cannot drift apart in either direction.
 *   2. Every location response boundary actually calls the projector —
 *      checked through a comment-masked view, because a comment naming
 *      the call (including one recording its removal) must not satisfy it.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    LocationListItemDTOSchema,
    LOCATION_LIST_ITEM_FIELDS,
    toLocationListItemDTO,
} from '@/lib/dto/location.dto';

/** A repository row: everything Prisma returns, documented or not. */
const RAW_ROW = {
    id: 'loc-1',
    tenantId: 't-1',
    key: 'NORTH',
    name: 'Северна нива',
    description: null,
    status: 'ACTIVE',
    kind: 'WAREHOUSE',
    capacityTonnes: '120.50', // Prisma Decimal serializes like this
    ownerUserId: 'u-1',
    spatialFileId: null,
    spatialFormat: null,
    boundsJson: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    owner: { id: 'u-1', name: 'Иван' },
    _count: { parcels: 3 },
    // Internal — no API consumer's business.
    createdByUserId: 'u-9',
    isSampleData: false,
    deletedAt: null,
    deletedByUserId: null,
    retentionUntil: null,
};

const INTERNAL_COLUMNS = [
    'createdByUserId',
    'isSampleData',
    'deletedAt',
    'deletedByUserId',
    'retentionUntil',
];

describe('Location response projection — the wire shape is the documented shape', () => {
    it('the projector and the DTO schema name exactly the same fields', () => {
        const documented = Object.keys(LocationListItemDTOSchema.shape).sort();
        expect([...LOCATION_LIST_ITEM_FIELDS].sort()).toEqual(documented);
    });

    it('no internal lifecycle column reaches the wire', () => {
        const out = toLocationListItemDTO(RAW_ROW) as Record<string, unknown>;
        for (const column of INTERNAL_COLUMNS) {
            expect(Object.prototype.hasOwnProperty.call(out, column)).toBe(false);
        }
    });

    it('the fields consumers actually read survive the projection', () => {
        const out = toLocationListItemDTO(RAW_ROW);
        // `kind` is read by the asset form's location picker — it was
        // undocumented, which is a DOC gap, not a leak. Stripping it on a
        // tidy-up would have broken that filter silently.
        expect(out.kind).toBe('WAREHOUSE');
        expect(out.id).toBe('loc-1');
        expect(out.name).toBe('Северна нива');
        expect(out.owner).toEqual({ id: 'u-1', name: 'Иван' });
        expect(out._count).toEqual({ parcels: 3 });
    });

    it('capacityTonnes leaves as a number, the way areaHa already does', () => {
        expect(toLocationListItemDTO(RAW_ROW).capacityTonnes).toBe(120.5);
        expect(toLocationListItemDTO({ ...RAW_ROW, capacityTonnes: null }).capacityTonnes).toBeNull();
    });

    it('SELF-TEST: a column added to the row later is not copied through', () => {
        // The projection is an allowlist. A new Prisma column joins the API
        // only when someone documents it here on purpose.
        const out = toLocationListItemDTO({ ...RAW_ROW, someFutureColumn: 'x' }) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(out, 'someFutureColumn')).toBe(false);
    });
});

// ─── Every response boundary calls it ────────────────────────────────

const ROUTES = [
    'src/app/api/t/[tenantSlug]/locations/route.ts',
    'src/app/api/t/[tenantSlug]/locations/[id]/route.ts',
];

/** Comment-masked source: a call surviving only in a comment must not count. */
function codeOf(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('Location response projection — applied at every boundary', () => {
    it.each(ROUTES)('%s projects before responding', (rel) => {
        const code = codeOf(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8'));
        expect(code).toMatch(/toLocationListItemDTO\s*\(/);
        // No location row handed straight to a response helper.
        expect(code).not.toMatch(/jsonResponse\(\s*location\s*\)/);
        expect(code).not.toMatch(/jsonWithETag\(\s*req\s*,\s*locations\s*\)/);
    });

    it('SELF-TEST: the boundary check reads code, not comments', () => {
        const onlyInComments = `
            // return jsonResponse(toLocationListItemDTO(location));
            /* toLocationListItemDTO(location) */
            export const GET = () => jsonResponse(location);`;
        expect(codeOf(onlyInComments)).not.toMatch(/toLocationListItemDTO\s*\(/);
        // POSITIVE CONTROL: as live code it IS seen, so the miss above is
        // the masking working rather than a broken pattern.
        expect(codeOf('jsonResponse(toLocationListItemDTO(location));')).toMatch(
            /toLocationListItemDTO\s*\(/,
        );
    });
});

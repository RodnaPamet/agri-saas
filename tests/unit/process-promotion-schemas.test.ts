/**
 * Zero-coverage zod contracts, wave 2 (part 2): process-map + promotion-admin.
 *
 * These two carry the branch shapes the simpler schemas don't — **cross-field**
 * `.refine()` rules and **array caps** — and neither was imported by any test.
 *
 * The cross-field rules are the interesting part: they encode invariants that a
 * per-field schema cannot express (exactly one company reference; a validity
 * window that doesn't run backwards), and they are precisely the rules a
 * refactor can drop without any type error.
 */
import {
    ProcessMapStatusSchema,
    ProcessNodeInputSchema,
    ProcessEdgeInputSchema,
    CreateProcessMapSchema,
    SaveProcessMapSchema,
} from '@/app-layer/schemas/process-map';
import {
    PROMOTION_CATEGORIES,
    PromotionCategorySchema,
    CreatePromotionSchema,
    UpdatePromotionSchema,
    SetPublishedSchema,
    UpdateCompanySchema,
} from '@/app-layer/schemas/promotion-admin.schemas';

// ─── process-map ─────────────────────────────────────────────────────

const node = (over = {}) => ({
    nodeKey: 'n1',
    nodeType: 'step',
    label: 'Receive grain',
    posX: 10,
    posY: 20,
    ...over,
});
const edge = (over = {}) => ({ edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2', ...over });

describe('process-map schemas', () => {
    it.each(['DRAFT', 'ACTIVE', 'ARCHIVED'])('accepts status %s', (s) => {
        expect(ProcessMapStatusSchema.safeParse(s).success).toBe(true);
    });

    it('rejects an unknown status', () => {
        expect(ProcessMapStatusSchema.safeParse('PUBLISHED').success).toBe(false);
    });

    describe('nodes', () => {
        it('accepts a minimal node', () => {
            expect(ProcessNodeInputSchema.safeParse(node()).success).toBe(true);
        });

        it('requires a key and a type', () => {
            expect(ProcessNodeInputSchema.safeParse(node({ nodeKey: '' })).success).toBe(false);
            expect(ProcessNodeInputSchema.safeParse(node({ nodeType: '' })).success).toBe(false);
        });

        it('rejects non-finite coordinates', () => {
            // A NaN position silently breaks canvas layout rather than erroring.
            expect(ProcessNodeInputSchema.safeParse(node({ posX: NaN })).success).toBe(false);
            expect(ProcessNodeInputSchema.safeParse(node({ posY: Infinity })).success).toBe(false);
        });

        it('accepts negative coordinates (canvas origin is not a corner)', () => {
            expect(ProcessNodeInputSchema.safeParse(node({ posX: -400, posY: -20 })).success).toBe(true);
        });

        it('allows null subtitle and parent (a root node with no strapline)', () => {
            expect(
                ProcessNodeInputSchema.safeParse(node({ subtitle: null, parentNodeKey: null })).success,
            ).toBe(true);
        });

        it('accepts arbitrary dataJson', () => {
            expect(
                ProcessNodeInputSchema.safeParse(node({ dataJson: { anything: [1, 2] } })).success,
            ).toBe(true);
        });
    });

    describe('edges', () => {
        it('defaults edgeKind to flow', () => {
            const r = ProcessEdgeInputSchema.safeParse(edge());
            expect(r.success).toBe(true);
            if (r.success) {
                expect(r.data.edgeKind).toBe('flow');
                expect(r.data.controls).toEqual([]);
            }
        });

        it('requires both endpoints', () => {
            expect(ProcessEdgeInputSchema.safeParse(edge({ sourceKey: '' })).success).toBe(false);
            expect(ProcessEdgeInputSchema.safeParse(edge({ targetKey: '' })).success).toBe(false);
        });

        it('caps attached controls at 64', () => {
            const controls = (n: number) =>
                Array.from({ length: n }, (_, i) => ({ controlKey: `c${i}`, label: `C${i}` }));
            expect(ProcessEdgeInputSchema.safeParse(edge({ controls: controls(64) })).success).toBe(true);
            expect(ProcessEdgeInputSchema.safeParse(edge({ controls: controls(65) })).success).toBe(false);
        });
    });

    describe('endpoint payloads', () => {
        it('requires a name to create a map', () => {
            expect(CreateProcessMapSchema.safeParse({}).success).toBe(false);
            expect(CreateProcessMapSchema.safeParse({ name: 'Grain intake' }).success).toBe(true);
        });

        it('accepts both canvas modes and rejects others', () => {
            for (const canvasMode of ['DOCUMENT', 'AUTOMATION']) {
                expect(CreateProcessMapSchema.safeParse({ name: 'M', canvasMode }).success).toBe(true);
            }
            expect(CreateProcessMapSchema.safeParse({ name: 'M', canvasMode: 'FREEFORM' }).success).toBe(false);
        });

        it('requires nodes and edges arrays on save', () => {
            expect(SaveProcessMapSchema.safeParse({ nodes: [] }).success).toBe(false);
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: [] }).success).toBe(true);
        });

        it('caps the graph at 500 nodes and 1000 edges', () => {
            const nodes = (n: number) => Array.from({ length: n }, (_, i) => node({ nodeKey: `n${i}` }));
            expect(SaveProcessMapSchema.safeParse({ nodes: nodes(500), edges: [] }).success).toBe(true);
            expect(SaveProcessMapSchema.safeParse({ nodes: nodes(501), edges: [] }).success).toBe(false);

            const edges = (n: number) => Array.from({ length: n }, (_, i) => edge({ edgeKey: `e${i}` }));
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: edges(1000) }).success).toBe(true);
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: edges(1001) }).success).toBe(false);
        });

        it('treats expectedVersion as an optional positive integer', () => {
            // Optimistic concurrency (Epic P1): omitting it is last-write-wins
            // for older clients, so the schema must keep accepting its absence.
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: [] }).success).toBe(true);
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: [], expectedVersion: 1 }).success).toBe(true);
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: [], expectedVersion: 0 }).success).toBe(false);
            expect(SaveProcessMapSchema.safeParse({ nodes: [], edges: [], expectedVersion: 1.5 }).success).toBe(false);
        });
    });
});

// ─── promotion-admin ─────────────────────────────────────────────────

describe('promotion-admin schemas', () => {
    const base = { title: 'Spring seed offer', category: PROMOTION_CATEGORIES[0] };

    it('accepts every published category', () => {
        for (const c of PROMOTION_CATEGORIES) {
            expect(PromotionCategorySchema.safeParse(c).success).toBe(true);
        }
        expect(PromotionCategorySchema.safeParse('MISC').success).toBe(false);
    });

    describe('exactly-one-company rule (cross-field)', () => {
        // A promotion attaches to an existing company OR names a new one.
        // Both, or neither, is ambiguous — and a per-field schema cannot say so.
        it('accepts an existing company id', () => {
            expect(CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1' }).success).toBe(true);
        });

        it('accepts a new company name', () => {
            expect(CreatePromotionSchema.safeParse({ ...base, companyName: 'New Agro' }).success).toBe(true);
        });

        it('rejects both at once', () => {
            expect(
                CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', companyName: 'New Agro' })
                    .success,
            ).toBe(false);
        });

        it('rejects neither', () => {
            expect(CreatePromotionSchema.safeParse(base).success).toBe(false);
        });

        it('still rejects both on update', () => {
            expect(
                UpdatePromotionSchema.safeParse({ companyId: 'co-1', companyName: 'X' }).success,
            ).toBe(false);
        });
    });

    describe('validity window (cross-field)', () => {
        it('accepts a window that runs forwards', () => {
            const r = CreatePromotionSchema.safeParse({
                ...base,
                companyId: 'co-1',
                validFrom: '2026-07-01',
                validTo: '2026-08-01',
            });
            expect(r.success).toBe(true);
        });

        it('accepts equal dates (a single-day promotion)', () => {
            expect(
                CreatePromotionSchema.safeParse({
                    ...base,
                    companyId: 'co-1',
                    validFrom: '2026-07-01',
                    validTo: '2026-07-01',
                }).success,
            ).toBe(true);
        });

        it('rejects a window that runs backwards', () => {
            expect(
                CreatePromotionSchema.safeParse({
                    ...base,
                    companyId: 'co-1',
                    validFrom: '2026-08-01',
                    validTo: '2026-07-01',
                }).success,
            ).toBe(false);
        });

        it('accepts an open-ended window (only one bound set)', () => {
            expect(
                CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', validFrom: '2026-07-01' })
                    .success,
            ).toBe(true);
            expect(
                CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', validTo: '2026-07-01' })
                    .success,
            ).toBe(true);
        });
    });

    it('requires a valid CTA URL when present', () => {
        expect(
            CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', ctaUrl: 'not a url' }).success,
        ).toBe(false);
        expect(
            CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', ctaUrl: null }).success,
        ).toBe(true);
    });

    it('bounds title and body', () => {
        expect(
            CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', title: 'x'.repeat(301) }).success,
        ).toBe(false);
        expect(
            CreatePromotionSchema.safeParse({ ...base, companyId: 'co-1', body: 'x'.repeat(4001) }).success,
        ).toBe(false);
    });

    it('validates the publish toggle', () => {
        expect(SetPublishedSchema.safeParse({ published: true }).success).toBe(true);
        expect(SetPublishedSchema.safeParse({ published: 'yes' }).success).toBe(false);
        expect(SetPublishedSchema.safeParse({}).success).toBe(false);
    });

    describe('UpdateCompanySchema', () => {
        it('rejects an empty patch', () => {
            // `.refine(keys.length > 0)` — a PATCH with no fields is almost
            // always a client bug, and it would otherwise touch updatedAt for
            // no reason.
            expect(UpdateCompanySchema.safeParse({}).success).toBe(false);
        });

        it('accepts a single-field patch', () => {
            expect(UpdateCompanySchema.safeParse({ contactName: 'Maria' }).success).toBe(true);
        });

        it('accepts null to clear an optional field', () => {
            expect(UpdateCompanySchema.safeParse({ notes: null }).success).toBe(true);
        });

        it('validates URL and email shapes', () => {
            expect(UpdateCompanySchema.safeParse({ websiteUrl: 'nope' }).success).toBe(false);
            expect(UpdateCompanySchema.safeParse({ contactEmail: 'not-an-email' }).success).toBe(false);
            expect(
                UpdateCompanySchema.safeParse({
                    websiteUrl: 'https://agro.example',
                    contactEmail: 'maria@agro.example',
                }).success,
            ).toBe(true);
        });

        it('strips unknown keys — but a patch of ONLY unknown keys is empty', () => {
            // `.strip()` runs before `.refine()`, so `{ sneaky: 1 }` becomes `{}`
            // and is correctly rejected as "no fields to update".
            expect(UpdateCompanySchema.safeParse({ sneaky: 1 }).success).toBe(false);
        });
    });
});

/**
 * Global (deliberately tenant-less) catalogue models.
 *
 * Most tenant-isolation guardrails work by SUBTRACTION: `rls-coverage` and
 * `schema-index-coverage` build their inventory from models that HAVE a
 * `tenantId` field, so a table without one is silently excluded. That makes
 * "no tenantId" indistinguishable from "forgot the tenantId" — the absence of a
 * failure is not evidence of a decision.
 *
 * This test is the positive counterpart: it NAMES the models whose tenant-less
 * design is deliberate, with the reason, and fails if one of them ever gains a
 * `tenantId` (or is deleted) without the entry being revisited in the same
 * diff. The subtractive guardrails stay authoritative for everything else — an
 * entry here is a written justification, not an exemption from them.
 *
 * NOTE: this is intentionally NOT a new exception list inside
 * `rls-coverage.test.ts`. `docs/implementation-notes/2026-07-15-trends-data-
 * backbone.md` records the correct precedent for adding a global table — "add
 * no tenantId, add no list entries" — and nothing here changes that.
 */
import { parseSchemaModels } from '../helpers/prisma-schema-models';
import { TENANT_SCOPED_MODELS } from '@/lib/db/rls-middleware';

/** model name → why it is deliberately global. */
const GLOBAL_CATALOGUE_MODELS: Record<string, string> = {
    Unit: 'Units of measure (kg, l, ha, дка) are universal — a per-tenant copy would fragment conversion.',
    AgriEvent:
        '#15 — fairs, trainings, webinars and subsidy deadlines are national facts, identical for ' +
        'every Bulgarian farm. Curated by platform-admin (/api/admin/agri-events); tenants read only.',
    Promotion:
        '#12 — supplier promotions are a shared lead-gen feed. The tenant-scoped side of the ' +
        'relationship is PromotionLead, which DOES carry a tenantId.',
    Company:
        '#12 — the supplier catalogue behind Promotion. One advertiser is one row for every ' +
        'tenant; a per-tenant copy would fork a supplier per farm. Its contact fields are ' +
        'encrypted under the GLOBAL KEK (see GLOBAL_KEK_MODELS) precisely because it has no ' +
        'tenant whose DEK could own them.',
    SoilSample:
        'Global soil-analysis cache keyed by geography, not by farm — two tenants sampling the ' +
        'same coordinates should hit the same row.',
    Book:
        '#2980 «Вдъхновение» — a book is reference data every farm reads the same copy of, like ' +
        'Unit and AgriEvent. A tenantId would fork one public-domain text per farm. Seeded and ' +
        'administered: it has an RLS SELECT arm (published rows, any authenticated caller, in ' +
        'EITHER session context) and deliberately no app_user write arm.',
    BookChapter:
        '#2980 — the chapters of a Book, and tenantless for the same reason. Its SELECT arm asks ' +
        'the PARENT whether it is published, because hiding the book row while serving its text ' +
        'is the whole of the leak rather than a partial fix.',
};

describe('global catalogue models — deliberately tenant-less', () => {
    const models = parseSchemaModels();
    const byName = new Map(models.map((m) => [m.name, m]));

    for (const [name, reason] of Object.entries(GLOBAL_CATALOGUE_MODELS)) {
        describe(name, () => {
            it('still exists in the schema', () => {
                expect(reason.length).toBeGreaterThan(20);
                expect(byName.has(name)).toBe(true);
            });

            it('has no tenantId — the global design still holds', () => {
                const model = byName.get(name);
                if (!model) return; // reported by the test above
                expect(model.hasField('tenantId')).toBe(false);
            });

            it('is absent from the RLS tenant-scoped inventory', () => {
                expect(TENANT_SCOPED_MODELS.has(name)).toBe(false);
            });
        });
    }

    it('every entry names a real model (no stale entries)', () => {
        const stale = Object.keys(GLOBAL_CATALOGUE_MODELS).filter((n) => !byName.has(n));
        expect(stale).toEqual([]);
    });
});

/**
 * Every encrypted model with no `tenantId` is pinned to the global KEK.
 *
 * ── the rule, and why it needs a guard ──
 *
 * `GLOBAL_KEK_MODELS` in `encryption-middleware.ts` states it in prose: *a model
 * with no `tenantId` column belongs here if any of its fields are encrypted.*
 * Until now nothing checked it, and the cost of that was #1222.
 *
 * `ExchangeMessage` has no `tenantId` (the schema says so in terms — its
 * idempotency key is "scoped to `senderTenantId` rather than a `tenantId` the
 * row does not have") and its `body` was being encrypted, so it satisfied the
 * rule's condition and was absent from the set. The middleware therefore
 * encrypted it under the WRITER's tenant DEK, while `listThreadMessages` reads
 * in the VIEWING party's context — so the other party read `v2:…` where the
 * message should be. Measured on production: both messages on the only live
 * thread were written by one tenant, so the recipient could read neither.
 *
 * ── what makes this failure invisible without a guard ──
 *
 * Nothing errors. The writer reads their own rows perfectly, every test that
 * exercises one tenant passes, and the ciphertext is well-formed. The defect is
 * only visible from the OTHER party's context, which no suite entered. A
 * structural rule is the only thing that catches it at the moment the model is
 * declared rather than when a user complains.
 *
 * ── the inverse is checked too ──
 *
 * A TENANT-SCOPED model must NOT be in the set: it would silently lose
 * per-tenant key isolation, which is a real security property and the whole
 * point of the v2 envelope. That direction fails toward "less isolation while
 * everything still works", so it needs a check more than the first does.
 */
import { Prisma } from '@prisma/client';
import { ENCRYPTED_FIELDS } from '../../src/lib/security/encrypted-fields';
import { GLOBAL_KEK_MODELS } from '../../src/lib/db/encryption-middleware';

/**
 * Models with no `tenantId` that DELIBERATELY use a per-tenant DEK anyway.
 *
 * The rule has one documented exception and this guard found it on its first
 * run — which is the useful outcome, because adding `PromotionLead` to
 * `GLOBAL_KEK_MODELS` to make a guard green would have silently reversed a
 * recorded design decision.
 *
 * The distinction the rule actually turns on is not "has a tenantId" but **how
 * many tenants must read the row**:
 *
 *   · `ExchangeMessage` — BOTH parties read every message, in the viewing
 *     party's own context. No per-tenant key can work.
 *   · `PromotionLead` — ONE tenant reads it: the farmer who wrote the enquiry.
 *     CLAUDE.md and `prisma/schema/promotions.prisma` both state the posture:
 *     "the message belongs to the farmer, so per-tenant key isolation is the
 *     correct posture. A reader outside that tenant (the future digest job)
 *     must therefore resolve each lead's tenant context to decrypt." The
 *     cross-tenant reader is a deliberate, accepted cost — not a break.
 *
 * An entry here is a claim that a single tenant reads the row and that any
 * cross-tenant reader resolves context deliberately. Adding one without that
 * being true recreates #1222.
 */
const DELIBERATELY_TENANT_DEK: Readonly<Record<string, string>> = {
    PromotionLead:
        'Read by ONE tenant — the inquiring farm that wrote it. Per-tenant key isolation is ' +
        'the recorded posture (CLAUDE.md + promotions.prisma); the future lead-digest job ' +
        'resolves each lead\'s tenant context to decrypt, which is accepted rather than a gap.',
};

const MODELS = Prisma.dmmf.datamodel.models;

/** Does this Prisma model carry a plain `tenantId` scalar? */
function hasTenantId(modelName: string): boolean {
    const m = MODELS.find((x) => x.name === modelName);
    return !!m?.fields.some((f) => f.name === 'tenantId' && f.kind === 'scalar');
}

const ENCRYPTED_MODELS = Object.keys(ENCRYPTED_FIELDS);

describe('GLOBAL_KEK_MODELS covers every tenantless encrypted model', () => {
    it('the populations are non-trivial', () => {
        // A zero on either side makes both assertions below vacuous.
        expect(MODELS.length).toBeGreaterThan(50);
        expect(ENCRYPTED_MODELS.length).toBeGreaterThan(5);
        expect(GLOBAL_KEK_MODELS.size).toBeGreaterThan(1);
    });

    it('every ENCRYPTED_FIELDS model exists in the datamodel', () => {
        // Otherwise `hasTenantId` answers false for a typo and the model gets
        // demanded into GLOBAL_KEK_MODELS for the wrong reason.
        expect(ENCRYPTED_MODELS.filter((m) => !MODELS.some((x) => x.name === m))).toEqual([]);
    });

    it('no tenantless encrypted model is MISSING from the set', () => {
        const missing = ENCRYPTED_MODELS.filter(
            (m) => !hasTenantId(m) && !GLOBAL_KEK_MODELS.has(m) && !(m in DELIBERATELY_TENANT_DEK),
        );
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} encrypted model(s) have no tenantId and are NOT in ` +
                    `GLOBAL_KEK_MODELS:\n  ` +
                    missing.join('\n  ') +
                    `\n\nThe middleware will encrypt them under whichever tenant's DEK happens ` +
                    `to be in context on the write, and any OTHER reader gets the raw \`v2:\` ` +
                    `envelope. Nothing errors — the writer reads its own rows fine — so this is ` +
                    `only visible from a context no test enters. That was #1222. Add the model ` +
                    `to GLOBAL_KEK_MODELS, and repair existing v2 rows with ` +
                    `repairMisplacedV2() in app-layer/usecases/global-key-rotation.ts.`,
            );
        }
    });

    it('no TENANT-SCOPED model is wrongly IN the set', () => {
        // The opposite error, and the more dangerous direction: it fails toward
        // less key isolation with everything still working.
        const wrong = [...GLOBAL_KEK_MODELS].filter((m) => hasTenantId(m));
        if (wrong.length > 0) {
            throw new Error(
                `${wrong.length} TENANT-SCOPED model(s) are in GLOBAL_KEK_MODELS:\n  ` +
                    wrong.join('\n  ') +
                    `\n\nThey would encrypt under the global KEK and lose per-tenant key ` +
                    `isolation — a real security property, and one that is achievable for them. ` +
                    `Only models that cannot have it (no tenantId; or more than one tenant must ` +
                    `read the same row) belong there.`,
            );
        }
    });

    it('every member of the set exists and is tenantless — no stale entries', () => {
        for (const m of GLOBAL_KEK_MODELS) {
            expect(MODELS.some((x) => x.name === m)).toBe(true);
            expect(hasTenantId(m)).toBe(false);
        }
    });

    it('every DELIBERATELY_TENANT_DEK entry is real, tenantless and encrypted', () => {
        // Without this the exemption map becomes a place to hide a model that
        // was renamed, deleted, or quietly given a tenantId — and then the rule
        // stops covering something it should.
        for (const [model, reason] of Object.entries(DELIBERATELY_TENANT_DEK)) {
            expect(MODELS.some((x) => x.name === model)).toBe(true);
            expect(hasTenantId(model)).toBe(false);
            expect(ENCRYPTED_MODELS).toContain(model);
            // And it must NOT also be in the global set — that would be two
            // contradictory declarations with the set silently winning.
            expect(GLOBAL_KEK_MODELS.has(model)).toBe(false);
            expect(reason.length).toBeGreaterThan(60);
        }
    });

    it('the models the rule is ABOUT are in the set, by name', () => {
        // Derived assertions above would still pass if ENCRYPTED_FIELDS were
        // emptied. These name the cases the rule exists for.
        expect(GLOBAL_KEK_MODELS.has('Tenant')).toBe(true);
        expect(GLOBAL_KEK_MODELS.has('Company')).toBe(true);
        expect(GLOBAL_KEK_MODELS.has('ExchangeMessage')).toBe(true);
    });
});

describe('the detector can tell the two shapes apart', () => {
    it('hasTenantId discriminates', () => {
        // Positive and negative control on the predicate the whole guard rests
        // on. If it answered one way for everything, both directions above
        // would pass for free.
        expect(hasTenantId('Task')).toBe(true);
        expect(hasTenantId('ExchangeMessage')).toBe(false);
        expect(hasTenantId('Tenant')).toBe(false);
        // A relation named tenant must not be mistaken for the scalar.
        const task = MODELS.find((m) => m.name === 'Task');
        expect(task?.fields.some((f) => f.name === 'tenantId' && f.kind === 'scalar')).toBe(true);
    });

    it('an unknown model is not silently treated as tenantless', () => {
        // `hasTenantId('NoSuchModel')` is false, which would DEMAND it into the
        // set. The existence assertion above is what stops a typo in
        // ENCRYPTED_FIELDS turning into a bogus membership requirement.
        expect(hasTenantId('NoSuchModel')).toBe(false);
        expect(MODELS.some((x) => x.name === 'NoSuchModel')).toBe(false);
    });
});

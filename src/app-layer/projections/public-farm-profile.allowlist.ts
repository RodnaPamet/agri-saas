/**
 * What may cross from a farm's private brand record into its public profile
 * (P6.1, #1810).
 *
 * The phase requires the projection to be "written only through an exhaustive
 * field allowlist". This is that allowlist, and **exhaustive** here means
 * compile-time: `Record<keyof FarmBrand, FieldDecision>` demands a key for
 * every column on the model, so adding one to the schema is a `tsc` error in
 * this file until somebody decides whether it is published.
 *
 * A list of published field names would NOT have that property. It would
 * compile unchanged after a new column appeared, and the new column would be
 * private by omission — which is the safe direction, but silently, and the
 * next person would have no way to tell a considered omission from a forgotten
 * one. That distinction is the whole point of the ratchets in this repo.
 *
 * ## This is the second line of defence, not the first
 *
 * `PublicFarmProfile` has no PII columns at all. ЕГН, ЕИК, address,
 * municipality and settlement live on `FarmProfile` and have no counterpart on
 * the projection, so even a writer that ignored this file could not leak them
 * — there is nowhere for the value to land. The allowlist exists for the
 * fields that *could* plausibly be published and should not be, and for
 * forcing the decision when a new one arrives.
 *
 * ## Why `private` carries a reason and `published` does not
 *
 * A published field is self-evident from the projection's own schema, which
 * documents each column. A PRIVATE field is a decision with no other record,
 * so each one says why — otherwise the next person reading this file sees a
 * bare `'private'` and cannot tell whether it is a privacy decision, a
 * bookkeeping column, or an oversight.
 */
import type { FarmBrand } from '@prisma/client';

/** Published, or deliberately not. */
export type FieldDecision =
    | { readonly decision: 'published' }
    | { readonly decision: 'private'; readonly why: string };

const published = (): FieldDecision => ({ decision: 'published' });
const privateField = (why: string): FieldDecision => ({ decision: 'private', why });

/**
 * EVERY column on `FarmBrand`, decided.
 *
 * `Record<keyof FarmBrand, …>` is load-bearing: remove a key and `tsc`
 * refuses, add a column to the model and `tsc` refuses until it is listed.
 * Prisma's model type carries scalars only, so the `tenant` relation is
 * correctly absent rather than needing an exception.
 */
export const BRAND_FIELD_DECISIONS: Record<keyof FarmBrand, FieldDecision> = {
    // ── published ──
    handle: published(),
    displayName: published(),
    tagline: published(),
    about: published(),
    oblast: published(),
    crops: published(),

    // ── private ──
    id: privateField(
        'The brand row’s own surrogate key. The projection is keyed by `handle`, '
            + 'which is the only identifier a public URL names; exposing this one would '
            + 'publish an internal id that nothing public needs.',
    ),
    tenantId: privateField(
        'The internal tenant id, used in authenticated URLs as `/t/{tenantSlug}`. '
            + 'Publishing it is the coupling the owner’s handle ruling exists to '
            + 'avoid, and it is why the projection carries no `tenantId` column at all.',
    ),
    projectedHandle: privateField(
        'Bookkeeping for this writer: the handle currently live in the projection, so a '
            + 'rename can remove the stale row. Meaningless to a reader and a record of '
            + 'what the farm used to be called.',
    ),
    published: privateField(
        'The switch itself. A projection row EXISTS only while this is true, so the '
            + 'flag is expressed as presence rather than as a field — a public row '
            + 'carrying `published: false` would be a contradiction a client could read.',
    ),
    publishedAt: privateField(
        'When the farm last became public. Operational history rather than part of the '
            + 'page, and `projectedAt` on the projection already gives a reader the '
            + 'freshness they need.',
    ),
    consentedAt: privateField(
        'When consent to publish was given (P6.6). A compliance record about the '
            + 'OWNER’s act, not a fact about the farm — and publishing the '
            + 'timestamp would tell a stranger when somebody was persuaded to opt in.',
    ),
    consentTextVersion: privateField(
        'Which consent text was shown. Same reasoning as `consentedAt`; it is evidence '
            + 'for an audit, not content for a page.',
    ),
    createdAt: privateField(
        'When the brand row was created, which is not when the farm was founded and '
            + 'would be read as though it were.',
    ),
    updatedAt: privateField(
        'When the owner last edited, including edits they never published. It would '
            + 'leak private activity — a reader could tell a draft was being worked '
            + 'on. `projectedAt` is the public-facing equivalent and moves only on '
            + 'publish.',
    ),
};

/** The field names that may cross, derived rather than listed twice. */
export const PUBLISHED_BRAND_FIELDS = (
    Object.keys(BRAND_FIELD_DECISIONS) as Array<keyof FarmBrand>
).filter((k) => BRAND_FIELD_DECISIONS[k].decision === 'published');

/**
 * Build the projection payload through the allowlist.
 *
 * Lives HERE and not in the usecase, for two reasons. It is the allowlist's
 * application rather than a step in a workflow — the decision table above and
 * the function that honours it belong together, so a change to one is read
 * beside the other. And `tests/guards/regression-scanner.test.ts` forbids
 * `throw new Error(` under `src/app-layer/usecases/`, correctly: a usecase's
 * throws are user-facing refusals and must carry codes a client can translate.
 * The three throws below are the opposite — INVARIANT violations that mean the
 * caller skipped a precondition, which no client can act on and no translation
 * would help. The guard pointing that out is what moved the function, and the
 * file it landed in is the better home independently.
 *
 * Reads `BRAND_FIELD_DECISIONS` rather than naming fields, so a field whose
 * decision changes to `published` starts crossing without this function being
 * touched — and one whose decision is `private` cannot cross even if someone
 * adds it to the projection's schema.
 *
 * Typed against the projection's own create input, so a published field with
 * no matching column is a `tsc` error here rather than a silent drop.
 */
export function projectionPayload(brand: {
    handle: string | null;
    displayName: string | null;
    tagline: string | null;
    about: string | null;
    oblast: string | null;
    crops: string[];
}): { handle: string; displayName: string; tagline: string | null; about: string | null; oblast: string | null; crops: string[] } {
    // Narrowed by the caller's preconditions; asserted again rather than cast,
    // because a cast here would be the one place the NOT NULL columns could be
    // violated and the failure would surface as a Prisma error with no cause.
    if (!brand.handle) throw new Error('projectionPayload called without a handle');
    if (!brand.displayName) throw new Error('projectionPayload called without a displayName');

    const out = {
        handle: brand.handle,
        displayName: brand.displayName,
        tagline: brand.tagline,
        about: brand.about,
        oblast: brand.oblast,
        crops: brand.crops,
    };

    // The allowlist is the authority, so a private field appearing in `out`
    // would be a defect in THIS function rather than in the allowlist. Checked
    // at runtime as well as by the shape above, because the shape is a type
    // and types do not survive a `JSON.parse` or a future spread.
    for (const key of Object.keys(out) as Array<keyof typeof out>) {
        const decision = BRAND_FIELD_DECISIONS[key];
        if (decision.decision !== 'published') {
            throw new Error(
                `projectionPayload would publish '${key}', which the allowlist marks private: `
                    + `${decision.decision === 'private' ? decision.why : ''}`,
            );
        }
    }
    return out;
}


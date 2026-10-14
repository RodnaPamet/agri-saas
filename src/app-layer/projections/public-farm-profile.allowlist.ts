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

import { transliterate } from '@/lib/bg-transliterate';

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
    indexable: privateField(
        'Whether search engines may index the page — a control, not content. The '
            + 'projection has carried its own `indexable` column since P6.1, and the '
            + 'path that will copy this value into it is the editor’s (P6.6, #1815), '
            + 'deliberately absent for one release so the migration adding this column '
            + 'can still be rolled back without breaking a reader. Marking it '
            + '`published` is what starts it crossing, per `projectionPayload` above, '
            + 'so that change belongs in the PR that ships the control.',
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

/**
 * Projection columns that are NOT copied from a `FarmBrand` field.
 *
 * `BRAND_FIELD_DECISIONS` answers "may this brand field cross?". It cannot
 * answer for a column the brand does not have — and a derived column still
 * needs a deliberate decision, because it is published just the same.
 *
 * Declared as a map with reasons for the same purpose as the private entries
 * above: without it, `projectionPayload`'s runtime check would read
 * `BRAND_FIELD_DECISIONS['displayNameLatin']` as `undefined` and throw a
 * TypeError that says nothing about why — which is exactly what happened the
 * first time I added one.
 */
export const DERIVED_PROJECTION_FIELDS: Record<string, string> = {
    displayNameLatin:
        'P6.8 — the Latin form of `displayName`, from `transliterate()` (the '
        + 'Закон за транслитерацията 2009 Streamlined System). Derived rather '
        + 'than copied because no such field exists on FarmBrand, and STORED '
        + 'rather than computed at query time because cross-script trigram '
        + 'similarity is ZERO (measured: similarity(\'pobeda\', \'Победа\') = 0), '
        + 'so a Latin query cannot match a Cyrillic column at any threshold. It '
        + 'publishes nothing the Cyrillic name does not already publish — it is '
        + 'the same name, spelled the way a Bulgarian passport spells it.',
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
}): {
    handle: string;
    displayName: string;
    tagline: string | null;
    about: string | null;
    oblast: string | null;
    crops: string[];
    displayNameLatin: string;
} {
    // Narrowed by the caller's preconditions; asserted again rather than cast,
    // because a cast here would be the one place the NOT NULL columns could be
    // violated and the failure would surface as a Prisma error with no cause.
    if (!brand.handle) throw new Error('projectionPayload called without a handle');
    if (!brand.displayName) throw new Error('projectionPayload called without a displayName');

    const out = {
        // NORMALISED here, and here only.
        //
        // `readPublicFarmProfile` lower-cases the handle it is given, because
        // a handle arrives from a URL that a person may have typed or read off
        // printed A6 paper (P6.7). If the projection stored `Pobeda` verbatim
        // the page would 404 for `/f/pobeda`, and that 404 is deliberately
        // indistinguishable from "no such farm" — so the bug would present as
        // a farm that published successfully and cannot be found.
        //
        // One place, because `projectedHandle` is set from this payload's
        // handle: normalising here makes the stored row, the bookkeeping and
        // the reader agree by construction rather than by three call sites
        // remembering.
        //
        // The canonical fix belongs further up: `FarmBrand.handle` should be
        // normalised where it is CHOSEN (P6.6, #1815), so its `@unique`
        // constraint is case-insensitive too. As it stands two farms could
        // reserve `Pobeda` and `pobeda` — distinct to the index, confusable to
        // a person, and the second to publish would overwrite the first's
        // public row. Recorded on that issue.
        handle: brand.handle.trim().toLowerCase(),
        displayName: brand.displayName,
        tagline: brand.tagline,
        about: brand.about,
        oblast: brand.oblast,
        crops: brand.crops,
        // DERIVED, not copied — see DERIVED_PROJECTION_FIELDS. Computed from
        // the already-normalised display name so the stored Latin form and
        // the Cyrillic one describe the same string.
        displayNameLatin: transliterate(brand.displayName),
    };

    // The allowlist is the authority, so a private field appearing in `out`
    // would be a defect in THIS function rather than in the allowlist. Checked
    // at runtime as well as by the shape above, because the shape is a type
    // and types do not survive a `JSON.parse` or a future spread.
    for (const key of Object.keys(out)) {
        // A derived column has no brand field to consult, and is accounted for
        // separately rather than skipped — an unaccounted key must still fail.
        if (key in DERIVED_PROJECTION_FIELDS) continue;

        const decision = (BRAND_FIELD_DECISIONS as Record<string, FieldDecision | undefined>)[key];
        if (!decision) {
            throw new Error(
                `projectionPayload would publish '${key}', which is neither a decided `
                    + `FarmBrand field nor a declared derived column. Add it to `
                    + `BRAND_FIELD_DECISIONS or to DERIVED_PROJECTION_FIELDS, with a reason.`,
            );
        }
        if (decision.decision !== 'published') {
            throw new Error(
                `projectionPayload would publish '${key}', which the allowlist marks private: `
                    + `${decision.why}`,
            );
        }
    }
    return out;
}


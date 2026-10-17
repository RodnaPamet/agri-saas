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
import { applyVisibility } from '@/lib/public-profile/visibility';

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
/**
 * The published fields an owner can WITHHOLD per field — P6.6 (#1815).
 *
 * The eye toggle's model. Each entry names the `FarmBrand` column that hides
 * it, and `projectFarmBrand` will omit the field when that column is true
 * while the text stays on the row — hiding is not deleting, which is the
 * owner's ruling of 2026-10-15.
 *
 * ## Why this is a PARTITION and not a list
 *
 * #1815: "a field visible in the editor but absent from the allowlist is a
 * control that does nothing, and a field in the allowlist with no toggle is
 * published with no way to withdraw it. Worth a test that enumerates both and
 * asserts they agree."
 *
 * A list of hideable fields can only be checked for membership. Together with
 * {@link NOT_HIDEABLE} this is EXHAUSTIVE over every `published()` field, so
 * the test can assert completeness: a new public field must arrive with a
 * toggle or with a written reason it has none. Neither half is optional, and
 * the test fails if their union misses a published field or names one twice.
 */
export const HIDEABLE_FIELDS = {
    tagline: 'hideTagline',
    about: 'hideAbout',
    oblast: 'hideOblast',
    crops: 'hideCrops',
} as const satisfies Partial<Record<keyof FarmBrand, keyof FarmBrand>>;

/**
 * Published fields that deliberately have NO toggle, each with the reason.
 *
 * Same shape of argument as `privateField(why)` below: the exemption is
 * recorded where the decision is, so the agreement test can demand a reason
 * rather than silently tolerating a gap.
 */
export const NOT_HIDEABLE = {
    handle: 'A publication PRECONDITION — `/f/{handle}` has no other key, so a '
        + 'published farm withholding it would have no page to serve.',
    displayName: 'A publication PRECONDITION, and NOT NULL on the projection: a '
        + 'public page with no name cannot be represented at all.',
    indexable: 'Not a field a visitor reads — it is the decision about whether '
        + 'search engines may index the page, and it has its own control.',
    logoMediaHash: 'An image, not a paragraph, and the difference is what makes a '
        + 'toggle unnecessary. The eye toggles exist because hiding a text field must '
        + 'not destroy the text — it lives only on this row, so withholding and '
        + 'deleting had to be separated. An image does not: the bytes are in storage '
        + 'under a content address that does not depend on this column, so clearing '
        + 'the column withholds the logo and loses nothing. Restoring it needs the '
        + 'hash, which the upload returns and which the editor can list from the '
        + 'tenant\'s `farm-media` files. A toggle would be a second way to express '
        + 'the same state, which is the control-that-does-nothing this partition '
        + 'exists to prevent.',
    photoMediaHashes: 'Same as `logoMediaHash`, and one thing more: the array IS '
        + 'the gallery, so removing a hash is the act of withdrawing that photograph. '
        + 'A flag withholding the whole gallery while the array stayed populated '
        + 'would mean two sources of truth for "what is on the page".',
} as const satisfies Partial<Record<keyof FarmBrand, string>>;

export const BRAND_FIELD_DECISIONS: Record<keyof FarmBrand, FieldDecision> = {
    // ── published ──
    handle: published(),
    displayName: published(),
    tagline: published(),
    about: published(),
    oblast: published(),
    crops: published(),
    // A control rather than content — it decides the page's `robots` meta and
    // whether `sitemap.xml` lists the farm — but it crosses to the projection
    // like any published field, because the public reader needs the value and
    // `PublicFarmProfile` is the only thing it reads.
    //
    // Was `private` for exactly one release. `FarmBrand.indexable` shipped in
    // #1850 and is contained in v12.34.0, so the phase rule is satisfied and
    // the writer may follow: until a tag held the column, flipping this would
    // have made a rollback of that migration break every projection refresh.
    indexable: published(),
    // The eye toggles themselves are PRIVATE, and the reason is sharper than
    // "nobody needs them". A flag says a field was WITHHELD, so publishing it
    // would tell a visitor that something exists they are not being shown —
    // which is the one thing hiding a field is supposed to avoid. The absence
    // of a tagline and a hidden tagline must look identical from outside.
    //
    // `Record<keyof FarmBrand, FieldDecision>` is what forced this decision:
    // adding the columns broke the build until each had an entry, which is
    // exactly why the allowlist is exhaustive rather than a list of the
    // fields somebody remembered.
    hideTagline: privateField(
        'An editorial decision, not content. Publishing it would reveal that a '
            + 'tagline exists and is being withheld.',
    ),
    hideAbout: privateField(
        'An editorial decision, not content. Publishing it would reveal that an '
            + '«За стопанството» text exists and is being withheld.',
    ),
    hideOblast: privateField(
        'An editorial decision, not content. Publishing it would reveal that the '
            + 'farm recorded an oblast and chose not to show it.',
    ),
    hideCrops: privateField(
        'An editorial decision, not content. Publishing it would reveal that a '
            + 'crop list exists and is being withheld.',
    ),

    // ── published, as of P6.3's writer ──
    //
    // `private` for exactly one release, which has now happened: the columns
    // shipped in #2029 and are contained in v12.73.1, so the phase rule is
    // satisfied and a rollback of that migration cannot leave this writer
    // naming a column the database lacks. Same sequence as `indexable` above.
    logoMediaHash: published(),
    photoMediaHashes: published(),

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
    indexable: boolean;
    hideTagline: boolean;
    hideAbout: boolean;
    hideOblast: boolean;
    hideCrops: boolean;
    logoMediaHash: string | null;
    photoMediaHashes: string[];
}): {
    handle: string;
    displayName: string;
    tagline: string | null;
    about: string | null;
    oblast: string | null;
    crops: string[];
    displayNameLatin: string;
    indexable: boolean;
    logoMediaHash: string | null;
    photoMediaHashes: string[];
} {
    // Narrowed by the caller's preconditions; asserted again rather than cast,
    // because a cast here would be the one place the NOT NULL columns could be
    // violated and the failure would surface as a Prisma error with no cause.
    if (!brand.handle) throw new Error('projectionPayload called without a handle');
    if (!brand.displayName) throw new Error('projectionPayload called without a displayName');

    /**
     * The eye toggles, applied by the SHARED rule — P6.6 (#1815).
     *
     * `applyVisibility` is also what the editor's live preview uses, so the
     * preview cannot disagree with the projection about whether a paragraph is
     * public. A preview that disagreed would be worse than none, because it is
     * believed.
     *
     * Hiding withholds from the PROJECTION only. The text stays on
     * `FarmBrand`, which is the owner's ruling — an eye toggle must be
     * reversible without retyping the paragraph.
     */
    const visible = applyVisibility(brand, brand);

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
        // The canonical fix landed further up in #1865: `claimFarmBrandHandle`
        // normalises where the handle is CHOSEN, through `checkHandleShape`,
        // so `FarmBrand.handle` now stores the lower-cased slug and two farms
        // can no longer reserve `Pobeda` and `pobeda` as distinct names. This
        // stays as a belt: the column's `@unique` is still case-SENSITIVE, so
        // the guarantee lives in application code rather than in the index,
        // and any future writer that skips the validator would reintroduce the
        // overwrite this normalisation prevents.
        handle: brand.handle.trim().toLowerCase(),
        displayName: brand.displayName,
        // Withheld fields are projected as ABSENT, not as the stored text.
        // `null` for the three nullable ones and `[]` for the list, which is
        // the cleared state a list already has — `updateFarmBrand` records the
        // same reasoning for why `crops` has no null form.
        //
        // A visitor cannot tell a hidden field from an unset one, and that is
        // required rather than incidental: the flags are `privateField` in
        // this very module precisely so the page never reveals that something
        // is being withheld.
        tagline: visible.tagline,
        about: visible.about,
        oblast: visible.oblast,
        crops: [...visible.crops],
        // DERIVED, not copied — see DERIVED_PROJECTION_FIELDS. Computed from
        // the already-normalised display name so the stored Latin form and
        // the Cyrillic one describe the same string.
        displayNameLatin: transliterate(brand.displayName),
        // The owner's search-engine choice, carried verbatim. Not derived and
        // not defaulted: a refresh must reproduce the decision, and defaulting
        // it here would quietly un-index a farm on the next edit.
        indexable: brand.indexable,
        // P6.3 (#1812). Carried verbatim and NOT through `applyVisibility`:
        // these are `NOT_HIDEABLE`, so there is no flag to consult, and
        // passing them through anyway would invent one.
        //
        // What crosses is a content HASH, never a path or an id. That is what
        // lets `/api/public/media/{hash}` be immutable and what keeps the
        // tenantless projection free of a reference it could not resolve.
        //
        // Copied rather than filtered: whether each hash is publishable was
        // decided by `assertPublishableMediaHashes` at WRITE time, inside the
        // tenant's own RLS context. Re-checking here would need a
        // cross-tenant file read from a projection writer that has no business
        // doing one — and would still be checking a decision already made.
        logoMediaHash: brand.logoMediaHash,
        photoMediaHashes: [...brand.photoMediaHashes],
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


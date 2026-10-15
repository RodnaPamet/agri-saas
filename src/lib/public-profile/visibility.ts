/**
 * Applying the eye toggles — P6.6 (#1815).
 *
 * ## Why this is its own module
 *
 * Two places have to answer "what does a visitor see?": `projectionPayload`,
 * which writes `PublicFarmProfile`, and the editor's live preview, which shows
 * the owner what they are about to publish. If the preview applied its own
 * version of the rule it would eventually disagree with the projection — and a
 * preview that disagrees about whether a paragraph is public is worse than no
 * preview, because it is believed.
 *
 * So the rule lives here and both callers use it, the same reasoning that put
 * the page's markup in one shared component.
 *
 * ## It imports NOTHING, deliberately
 *
 * The preview is inside a `'use client'` tree. The allowlist module would have
 * been the natural home — it already declares `HIDEABLE_FIELDS` — but it
 * imports from `@prisma/client` and `bg-transliterate`, and a client component
 * reaching a server-only module fails the BUILD with `UnhandledSchemeError`
 * while `tsc`, lint and every rendered test stay green (#1874). A module with
 * no imports cannot do that.
 */

/** The four optional published fields, as a visitor would receive them. */
export interface VisibleFields {
    readonly tagline: string | null;
    readonly about: string | null;
    readonly oblast: string | null;
    readonly crops: readonly string[];
}

export interface VisibilityFlags {
    readonly hideTagline: boolean;
    readonly hideAbout: boolean;
    readonly hideOblast: boolean;
    readonly hideCrops: boolean;
}

/**
 * Withhold the fields whose toggle is off.
 *
 * A hidden field comes back in the shape an UNSET one has — `null` for the
 * three nullable fields, `[]` for the list, which is the cleared state a list
 * already has. That is required rather than tidy: the flags are private
 * precisely so a page cannot reveal that something is being withheld, and that
 * only holds if a hidden tagline is indistinguishable from a farm that never
 * wrote one.
 *
 * Pure, and takes the stored values rather than reading them: the preview
 * passes UNSAVED form state, the projection passes the row.
 */
export function applyVisibility(fields: VisibleFields, flags: VisibilityFlags): VisibleFields {
    return {
        tagline: flags.hideTagline ? null : fields.tagline,
        about: flags.hideAbout ? null : fields.about,
        oblast: flags.hideOblast ? null : fields.oblast,
        crops: flags.hideCrops ? [] : fields.crops,
    };
}

/**
 * Request bodies for the farm-brand surface (P6.1, #1810).
 *
 * Declared ONCE, here, and imported by both the route and the OpenAPI module.
 * `tests/guards/request-body-declared-once.test.ts` caps a redeclared body at
 * zero: a route and a spec each with their own Zod for one body are two
 * schemas nothing compares, so a change to either is invisible to the other.
 */
import { z } from 'zod';

/**
 * Whether the farm is public.
 *
 * `z.boolean()` with no default, deliberately. A default would let a client
 * that forgot the field publish a farm by accident, and publishing is the
 * direction that is hard to take back — a page can be indexed, shared, or
 * printed onto paper before anybody notices.
 */
export const SetFarmBrandPublicationSchema = z.object({
    published: z.boolean(),
});

export type SetFarmBrandPublicationInput = z.infer<typeof SetFarmBrandPublicationSchema>;

/**
 * The public address an owner is claiming — P6.6 (#1815).
 *
 * The bound is a payload guard, NOT the rule. `checkHandleShape` decides
 * what is valid and why, and it does so on the TRANSLITERATED slug, which
 * can be longer than the input: `я` is one character that becomes `ya`, so a
 * forty-character Cyrillic name can normalise past a forty-character cap.
 * Bounding at 200 here keeps a megabyte of JSON out of the transliterator
 * while leaving every editorial refusal to the validator, so a too-long name
 * comes back as `FARM_HANDLE_TOO_LONG` rather than a generic schema error
 * that tells the owner nothing about which rule they broke.
 */
export const ClaimFarmBrandHandleSchema = z.object({
    handle: z.string().min(1).max(200),
});

export type ClaimFarmBrandHandleInput = z.infer<typeof ClaimFarmBrandHandleSchema>;

/**
 * The farm's own public content — P6.6 (#1815).
 *
 * Every field OPTIONAL and nullable, because this is the editor's save and an
 * owner fills it in over several sittings. `undefined` means "leave alone",
 * `null` means "clear it" — a distinction a client needs: clearing a tagline
 * and not having edited it are different intentions, and collapsing them
 * would make an autosave wipe fields the owner never opened.
 *
 * `displayName` is nullable here even though the projection's column is NOT
 * NULL. Publication is where that becomes required
 * (`FARM_BRAND_DISPLAY_NAME_REQUIRED`), and refusing a half-finished draft
 * would mean an owner cannot save a tagline before deciding on a name.
 *
 * Bounds are payload guards sized to what a public page can show, not
 * editorial judgement — `about` at 2000 is a few paragraphs, which is the
 * most the page renders before it stops being skimmable.
 */
export const UpdateFarmBrandSchema = z.object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    tagline: z.string().trim().max(200).nullable().optional(),
    about: z.string().trim().max(2000).nullable().optional(),
    oblast: z.string().trim().max(80).nullable().optional(),
    crops: z.array(z.string().trim().min(1).max(80)).max(40).optional(),
});

export type UpdateFarmBrandInput = z.infer<typeof UpdateFarmBrandSchema>;

/**
 * Consent to publish identifiable information about a real farm — P6.6.
 *
 * Its own call rather than a field on the content save, because it is a legal
 * artefact and not editor state: it records that a specific person was shown
 * a specific text and agreed. Folding it into a content `PUT` would let an
 * autosave record consent nobody read, which is the one thing a consent
 * record must never be able to claim.
 *
 * `textVersion` is what makes the record meaningful. "They consented" is
 * unfalsifiable a year later when the wording has changed; "they consented to
 * v2" can be checked against the v2 text.
 */
export const RecordFarmBrandConsentSchema = z.object({
    textVersion: z.string().trim().min(1).max(40),
});

export type RecordFarmBrandConsentInput = z.infer<typeof RecordFarmBrandConsentSchema>;

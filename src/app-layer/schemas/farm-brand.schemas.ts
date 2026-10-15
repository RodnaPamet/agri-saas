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

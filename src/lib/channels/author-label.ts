/**
 * «Иван Петров, ЗК Победа», or whichever half exists — #2989, extracted by
 * #3030.
 *
 * Four states, and three of them are normal rather than degraded: both halves
 * present, a name alone, a farm alone, or neither. The comma is the only
 * formatting decision and it belongs to the catalogue
 * (`channels.authorNameAndFarm`), because a locale that joins the two
 * differently must not need a code change.
 *
 * `null` for the both-absent case rather than an empty string: the timeline
 * treats `null` as "no label" and renders nothing, while an empty string is a
 * deliberate withholding it also honours. Either works; null is the honest one
 * for "we have nothing to show".
 *
 * ## Why this is a module and not a local function
 *
 * It lived inside `ChannelFeedClient` while the feed was the only surface
 * rendering a post. The permalink page (#3030) is the second, and a post's
 * attribution is a DISCLOSURE rule rather than formatting: `author` is null on
 * a hidden post precisely so nobody is named above content nobody can read,
 * and the fallback order decides what a reader is told about who wrote
 * something. A second spelling of that is how #2961's removal collapse
 * drifted — two read paths, one of which served what the other hid.
 *
 * So the rule is spelled once and both callers pass their own `t`, which is
 * also what keeps this file free of a React or next-intl import.
 */

/** The `author` field of a post view: both halves independently absent. */
export interface ChannelAuthor {
    displayName: string | null;
    farmName: string | null;
}

/**
 * Bind a joiner (normally `(vars) => t('authorNameAndFarm', vars)`) and get
 * back the mapper. Bound ONCE per locale by the caller — rebuilding it inside
 * a render pass would make a new function per render for no reason.
 */
export function makeAuthorLabel(
    joinNameAndFarm: (vars: { name: string; farm: string }) => string,
): (author: ChannelAuthor | null) => string | null {
    return (author) => {
        if (!author) return null;
        const name = author.displayName?.trim() || null;
        const farm = author.farmName?.trim() || null;
        if (name && farm) return joinNameAndFarm({ name, farm });
        return name ?? farm;
    };
}

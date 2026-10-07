/**
 * The terms version, and the one place it is spelled (P3.1).
 *
 * Three artefacts read this constant: the `/terms` page renders it, the
 * registration route stores it on the user who accepted, and the consent
 * notice shows a returning user which version they agreed to. If any of
 * those restated the value instead, a terms change would leave a user
 * recorded as having accepted a version they never saw — the kind of
 * drift the privacy page avoids by importing the retention constants the
 * sweep job runs on rather than writing "24 months" in prose.
 *
 * ── it is a DATE plus `-draft`, and the suffix is load-bearing ──
 *
 * These terms have not been through legal review (see the page's own
 * banner). The suffix means a stored consent record says so too: a row
 * reading `2026-10-07-draft` cannot later be mistaken for acceptance of
 * a reviewed document, which is exactly what a bare `1` or `1.0` would
 * allow once a reviewed version exists.
 *
 * ── changing it ──
 *
 * Bump this when the MEANING changes — a new obligation, a different
 * moderation rule, a changed liability position. Do not bump it for a
 * typo or a clearer sentence: every bump is a thing you are saying every
 * existing user has not yet agreed to, and a version history full of
 * copy-edits makes the one that mattered unfindable.
 *
 * `acceptedTermsVersion` is a plain string rather than an enum precisely
 * so an old row stays readable after this constant moves on. Nothing
 * reads it back as "current" — compare against this value explicitly if
 * you need to know whether a user is behind.
 */
export const TERMS_VERSION = '2026-10-07-draft';

/**
 * Whether these terms have been reviewed by a lawyer.
 *
 * Read by the page to decide whether to render the draft banner, so the
 * banner disappears with ONE edit here when a reviewed version lands,
 * rather than needing somebody to remember to delete markup. A reviewed
 * document with a banner saying it is unreviewed is as wrong as the
 * reverse.
 */
export const TERMS_ARE_LEGALLY_REVIEWED = false;

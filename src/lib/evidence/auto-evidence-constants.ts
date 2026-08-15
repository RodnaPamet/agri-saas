/**
 * Constants shared between the auto-evidence WRITER and its READERS.
 *
 * `attachAutoEvidenceFromLogEntry` stamped every row it created with a
 * category so the UI can tell derived evidence from evidence a person filed.
 * That writer was deleted by GRC teardown phase 3 (it minted through the
 * Practice graph), so the category is now READ-ONLY: it classifies rows
 * collected before the teardown, and nothing stamps a new one. That
 * category was a bare string literal on the write side and, until it was
 * hoisted here, was
 * neither selected by the list query nor referenced anywhere on the read side
 * — so the distinction existed in the database and nowhere a user could see
 * it. Every auto-collected farm record rendered as a generic "Link", identical
 * to a URL someone pasted in by hand, which is exactly the difference that
 * decides whether a row still needs a human to look at it.
 *
 * Client-importable on purpose: this module holds only literals, so the
 * evidence table can compare against the same constant the job writes.
 */

/** `Evidence.category` for a row derived from a farm journal entry. */
export const AUTO_FARM_RECORD_CATEGORY = 'AUTO_FARM_RECORD';

/**
 * The English prefix auto-evidence titles used to be persisted with
 * (`Farm record — {entry title}`).
 *
 * It was written server-side into the database, so it could not be
 * translated: a Bulgarian operator's evidence list showed English on every
 * auto-collected row, and no amount of next-intl work at render time could
 * reach it. Titles are now stored as the journal entry's own title, and the
 * "farm record" marker is rendered from `category` through next-intl in
 * whichever locale the reader is using.
 *
 * Kept here because the backfill migration strips exactly this string, and a
 * reader who finds the migration should be able to find the reason.
 */
export const LEGACY_AUTO_EVIDENCE_TITLE_PREFIX = 'Farm record — ';

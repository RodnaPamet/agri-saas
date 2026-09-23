/**
 * Titles the SERVER composes for entries nobody typed.
 *
 * An input application recorded from a spray line has no operator-written
 * title — the parcel sheet sends a product and a parcel, not a sentence — so
 * `recordInputApplication` composed one. It composed it in English, and on production **9 of
 * the 16 live journal entries carry one** (#1073) — with a 10th, the seeded
 * sample entry, written in the same shape by hand. Most of the diary a
 * Bulgarian operator reads was machine-written English.
 *
 * ── Why a descriptor and not just a Bulgarian string ──
 *
 * `CLAUDE.md` already states the rule for `DueItem.reason` and for outbound
 * email: **a value shown to a reader must not be a pre-rendered sentence**,
 * because the language is not knowable where the value is built. A usecase
 * does not know whether the reader is the web app, a Bulgarian operator's
 * phone, or a future export.
 *
 * Applying that rule to a PERSISTED value has a consequence the email path
 * never faced: a rendered sentence keeps no trace of what it was rendered
 * from, so rows already written cannot be re-rendered. That is exactly why
 * the English ones had to be rewritten by hand rather than fixed by a code
 * change. Storing `{ key, params }` means the next language decision costs
 * nothing.
 *
 * ── Why `title` is still written, in Bulgarian ──
 *
 * The descriptor is authoritative; `title` is its RENDERING, kept because
 * every current consumer reads it — the list column, the detail breadcrumb,
 * the native client, and `DeletedJournalView`'s typed-confirm purge, which
 * makes the operator retype the exact title to arm a permanent delete.
 * Leaving it blank would break that gesture silently.
 *
 * Bulgarian rather than English is the deliberate part, and not merely
 * because "the product is Bulgarian": `uiLanguage` defaults to `bg`, four of
 * five users carry it, and `FarmProfile` is built from Bulgarian registry
 * concepts (`egn`, `eik`, `registrationEkatte`). English as a fallback would
 * be a foreign string for every reader the product currently has.
 *
 * ── The constraint that decided the wording ──
 *
 * `LogEntryType` has ten values and the app renders a Bulgarian label for
 * each; `INPUT_APPLICATION` shows as «Внасяне на препарат» on a chip sitting
 * directly beside the title. So a composed Bulgarian title has to AGREE with
 * that chip, not merely be grammatical — «Приложен …» next to «Внасяне на
 * препарат» asserts two categories for one event.
 *
 * The old English was accidentally immune: `Applied X to Y` is so obviously
 * foreign that nobody reads it as a competing category claim. Translating it
 * PROMOTES the string into the chip's vocabulary, which is a new failure mode
 * rather than a leftover of the old one. Hence the phrasing names the product
 * and the parcel and leaves the categorising to the chip.
 */
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * The fallback language for a composed title.
 *
 * Deliberately NOT `DEFAULT_LOCALE`, which is `en` for unauthenticated
 * surfaces — the same distinction `resolveRecipientLocale` already draws for
 * email. A journal entry is read by a member of a Bulgarian farm.
 */
export const AUTO_TITLE_FALLBACK_LOCALE = 'bg' as const;

/** Every key this module can emit. One per composed-title shape. */
export const AUTO_TITLE_KEYS = {
    inputApplication: 'journal.autoTitle.inputApplication',
} as const;

export type AutoTitleKey = (typeof AUTO_TITLE_KEYS)[keyof typeof AUTO_TITLE_KEYS];

/**
 * Params for a composed title. Names and quantities only — never PII, the
 * same rule notification params carry.
 *
 * A type alias rather than an `interface` on purpose: these go into a Prisma
 * `Json` column, and an interface has no implicit index signature so it is
 * not assignable to `InputJsonValue`. The alias is, which keeps the call site
 * free of a cast that would also silence a genuinely wrong shape.
 */
export type AutoTitleParams = {
    product: string;
    parcel: string;
};

export interface ComposedTitle {
    title: string;
    titleKey: AutoTitleKey;
    titleParams: AutoTitleParams;
}

/**
 * Compose the title for an input-application entry.
 *
 * Returns all three columns together so a caller cannot write a rendering
 * without its descriptor, or a descriptor whose params disagree with the
 * string beside it. They are one value that happens to occupy three columns.
 */
export async function composeInputApplicationTitle(
    params: AutoTitleParams,
): Promise<ComposedTitle> {
    const title = await translateFor(
        AUTO_TITLE_FALLBACK_LOCALE,
        AUTO_TITLE_KEYS.inputApplication,
        { ...params },
    );
    return { title, titleKey: AUTO_TITLE_KEYS.inputApplication, titleParams: params };
}

/**
 * Does this entry's title belong to the server?
 *
 * The single predicate every read path should use, so "was this written by a
 * person" is answered one way everywhere rather than by each caller guessing
 * from the text.
 */
export function isAutoGeneratedTitle(entry: { titleKey?: string | null }): boolean {
    return typeof entry.titleKey === 'string' && entry.titleKey.length > 0;
}

/**
 * The exact shape the OLD composer emitted, before #1073:
 * `Applied ${product} to ${parcel}`.
 *
 * Kept beside the composer because it is that composition's inverse, and the
 * two must stay describable together — a parser for a format living far from
 * the writer of that format is how the two drift.
 *
 * The product group is GREEDY, so the split lands on the LAST ` to `. A
 * product named "Ready to Use 5" therefore parses correctly; a LAZY group
 * splits on the FIRST separator and yields product "Ready", parcel "Use 5 to
 * North Block". (This was written lazy first, on exactly that inverted
 * reasoning, and the test below caught it.)
 *
 * Neither direction is universally right — a PARCEL containing the separator
 * fails under greedy the way a product does under lazy. Greedy is the better
 * default here because agrochemical names routinely contain ordinary English
 * words while the parcels in this data are cadastral ids.
 *
 * What makes either choice SAFE is not the regex: the backfill corroborates
 * its parse against the linked operation's live product and parcel names and
 * SKIPS any row where the two disagree. A mis-split cannot be written; it can
 * only be reported. That is the property to preserve if this is ever touched.
 */
const LEGACY_COMPOSED_EN = /^Applied (.+) to ([^ ].*)$/;

/**
 * Recover the product and parcel from a legacy English title.
 *
 * Returns null when the title is not that shape — which is the answer for
 * anything a person wrote, and the reason the backfill can tell the two
 * apart without a provenance column existing at the time those rows were
 * written.
 */
export function parseLegacyComposedTitle(title: string): AutoTitleParams | null {
    const m = LEGACY_COMPOSED_EN.exec(title);
    if (!m) return null;
    return { product: m[1], parcel: m[2] };
}

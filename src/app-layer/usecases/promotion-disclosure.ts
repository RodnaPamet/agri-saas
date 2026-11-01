import prisma from '@/lib/prisma';
import { env } from '@/env';

/**
 * ════════════════════════════════════════════════════════════════════════
 *  THE MODEL-UNTOUCHED PATH. Do not fold this into the assistant's tool
 *  result, however much it looks like tidying.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Every value this returns is rendered by the CLIENT verbatim and must never
 * pass through a language model.
 *
 * ## Why, since merging it with `list_promotions` would be one fewer call
 *
 * Reg. (EC) 1107/2009 Art 66 requires prescribed safety wording on advertising
 * for plant protection products, and DSA Art 26 requires that a recipient can
 * tell on whose behalf an advertisement is presented. Both are texts whose
 * exact form is the point.
 *
 * If those strings reach the assistant's tool result, they are in the model's
 * CONTEXT — and a model that can see prescribed legal text can paraphrase it,
 * shorten it, or translate it to match the sentence it is writing. **A
 * paraphrased Art 66 phrase is worse than an absent one, because it looks
 * compliant.** An instruction not to restate it is the wrong strength of
 * control for mandatory legal text: an instruction is a request, and this has
 * to be a guarantee.
 *
 * So the assistant's tool returns company, product, price, end date and an ID;
 * this read resolves that id to the disclosure; and the client renders the
 * disclosure from a field the model demonstrably could not have altered.
 *
 * ## What breaks if somebody "simplifies" this
 *
 * Folding these two fields into the tool result would compile, pass every test
 * that checks the block renders, and read as a sensible de-duplication in
 * review. It would also silently remove the entire control. That is why this
 * banner is here and why it says what breaks rather than only what the module
 * does.
 *
 * ## Fail-closed, in two independent layers
 *
 * A ПРЗ promotion with no configured wording is NOT returned here, and is
 * already withheld from the tool upstream. Holding such an id is a bug on this
 * side; the assistant loop treats an empty disclosure as that bug and emits no
 * promotion frame at all. Neither layer depends on the other.
 */

export interface PromotionDisclosure {
    id: string;
    /** The advertiser's legal name, verbatim — DSA Art 26's "on whose behalf". */
    advertiser: string;
    /** Whether this promotion is for a plant protection product. */
    isPpp: boolean;
    /**
     * The prescribed Art 66 safety wording, for a ПРЗ. `null` for anything
     * else — not an empty string, because "no wording applies" and "the
     * wording is missing" are different states and only the second is a fault.
     */
    safetyWording: string | null;
}

/**
 * The configured ПРЗ advertising safety sentence.
 *
 * Deliberately an env var seeded ABSENT, and deliberately not a default
 * written by me: the authoritative Bulgarian text is a БАБХ or legal question,
 * and a plausible paraphrase hard-coded here would be the exact failure this
 * module exists to prevent — wording that looks official and is not.
 *
 * Absent ⇒ every ПРЗ promotion is withheld. A missing value costs a feature;
 * the other direction costs a breach.
 */
function configuredPppWording(): string | null {
    const raw = env.PPP_ADVERTISING_SAFETY_BG;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
}

/** Is the ПРЗ disclosure configured? Exported so the console can SAY it is not. */
export function isPppDisclosureConfigured(): boolean {
    return configuredPppWording() !== null;
}

/**
 * Resolve promotion ids to the strings the client renders itself.
 *
 * Returns FEWER rows than asked for when a promotion is a ПРЗ and the wording
 * is unconfigured. The caller must treat a missing id as "do not show this
 * promotion", never as "show it without the disclosure".
 */
export async function promotionDisclosures(ids: string[]): Promise<PromotionDisclosure[]> {
    if (ids.length === 0) return [];

    const rows = await prisma.promotion.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            pppRegistrationNo: true,
            company: { select: { name: true } },
        },
    });

    const wording = configuredPppWording();

    return rows.flatMap((r) => {
        const isPpp = r.pppRegistrationNo !== null;
        // The withholding, and the reason it is a `flatMap` rather than a field
        // left null: returning the row with `safetyWording: null` would hand the
        // caller something renderable, and the whole point is that there is
        // nothing safe to render.
        if (isPpp && wording === null) return [];
        return [{
            id: r.id,
            advertiser: r.company.name,
            isPpp,
            safetyWording: isPpp ? wording : null,
        }];
    });
}

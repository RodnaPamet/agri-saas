/**
 * A person's own public display name — #2989.
 *
 * ## Why this exists at all
 *
 * `PersonProfile` has been in the schema since P6 and, measured on production
 * 2026-11-12, held **zero rows** — because nothing in the product ever wrote
 * one. The channel author line reads `displayName` from a PUBLISHED profile,
 * so without a way in, every post in every channel shows the farm alone for
 * ever. That is #2844 a third time: a surface that exists, resolves, and is
 * reachable by nobody.
 *
 * ## Giving a name IS the opt-in, and that is the whole design
 *
 * `PersonProfile.published` defaults FALSE, deliberately — P6's comment says
 * "a person who has never opened the editor is not published, and the absence
 * of a row means the same thing". A writer that set `displayName` and left
 * `published` alone would therefore change NOTHING visible, which is the same
 * dormancy one level down: the person types their name, the post still shows
 * the farm alone, and nothing says why.
 *
 * So setting a name publishes it, and the copy at the call site has to say so
 * — `channels.displayNamePrompt.hint` carries «Името Ви ще се вижда от други
 * стопанства». The owner's decision (2026-11-12) accepted that a member's
 * name becomes visible to other farms' members in public channels; this makes
 * the person's own act the consent, rather than a second switch they never
 * find.
 *
 * ## Clearing it UNPUBLISHES
 *
 * The honest inverse. Someone who removes their name is asking not to be
 * named, and leaving `published: true` on a row with a null name would keep a
 * published profile that happens to render nothing — a state that looks like
 * a bug to the next reader and would start showing a name again the moment
 * any other writer set one.
 */
import { prisma } from '@/lib/prisma';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { codedBadRequest } from '@/lib/errors/types';
import type { UserContext } from '@/app-layer/types';

/** Long enough for «Иван Петров-Калоянов», short enough to render in a feed. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

export interface PersonProfileView {
    /** Null when unset, blank, or set-but-unpublished — see `readOwnProfile`. */
    readonly displayName: string | null;
    readonly published: boolean;
}

/**
 * The caller's own profile, or the empty state.
 *
 * This is also the SIGNAL both clients prompt from: `displayName: null` means
 * "this person has no name to show", so a composer can ask once before the
 * first post. A missing row and an unpublished row answer identically,
 * because they mean the same thing to a reader of a channel.
 *
 * On the global client: `PersonProfile` has row-level security DISABLED
 * (measured, `relrowsecurity` false), and this reads exactly one row by the
 * caller's own id.
 */
export async function readOwnProfile(ctx: UserContext): Promise<PersonProfileView> {
    const row = await prisma.personProfile.findUnique({
        where: { userId: ctx.userId },
        select: { displayName: true, published: true },
    });
    const name = row?.displayName?.trim();
    return {
        // Reported as absent unless it would actually RENDER. A caller
        // deciding whether to prompt must not be told a name exists when the
        // feed will show the farm alone.
        displayName: row?.published && name ? name : null,
        published: row?.published ?? false,
    };
}

/**
 * Set or clear the caller's display name.
 *
 * `null` or blank clears and unpublishes. Anything else is sanitised, capped,
 * and published — see the module docblock for why publishing is not a
 * separate act.
 */
export async function setOwnDisplayName(
    ctx: UserContext,
    input: { displayName: string | null },
): Promise<PersonProfileView> {
    const raw = input.displayName ?? '';
    // Sanitised at the USECASE, which is where `sanitize-rich-text-coverage`
    // looks, and before the length check so markup cannot smuggle a name past
    // the cap by being stripped afterwards.
    const name = sanitizePlainText(raw);
    if (name.length > DISPLAY_NAME_MAX_LENGTH) {
        throw codedBadRequest(
            'DISPLAY_NAME_TOO_LONG',
            `A display name may be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
        );
    }

    const clearing = name.length === 0;
    const row = await prisma.personProfile.upsert({
        where: { userId: ctx.userId },
        // `published` is written on BOTH paths rather than only on create:
        // an existing row that was published once must stop being published
        // when the name is cleared, and must resume when a name is set again.
        create: {
            userId: ctx.userId,
            displayName: clearing ? null : name,
            published: !clearing,
        },
        update: {
            displayName: clearing ? null : name,
            published: !clearing,
        },
        select: { displayName: true, published: true },
    });
    return {
        displayName: row.published && row.displayName ? row.displayName : null,
        published: row.published,
    };
}

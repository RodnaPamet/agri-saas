/**
 * The one composition of an Art 17 statement of reasons (#1667).
 *
 * ## Why this is its own module
 *
 * The body existed in exactly one place — inside `runStatementDispatch`'s loop
 * — and that was correct while a human typed the draft: the console's
 * `bodyRendered` was prose a moderator wrote, and the job's composition
 * replaced it at send time with the localised version.
 *
 * #1667's first ruling is that a statement is queued AUTOMATICALLY from both
 * action paths, so there is now no human to type a draft. The queue step has
 * to compose one — and if it composed its own, the draft and the delivered
 * text would be two spellings of the same obligation, free to drift.
 *
 * That drift has a specific cost here. The console's undelivered view is where
 * a moderator checks what is about to go out; a draft that does not match what
 * the job will send makes that view a lie about a legal communication.
 *
 * It is the same failure `subjectMayCancelErasure` was extracted for in #1678,
 * which diverged twice before being fixed by construction rather than by a
 * comment asking the next person to remember.
 *
 * ## The draft is still a DRAFT, and that is deliberate
 *
 * Art 17 requires the recipient's language, which is only knowable at send
 * time — a person can change `uiLanguage` between the decision and the send.
 * So the queue step composes in the recipient's language AS IT IS THEN, and
 * the job recomposes and overwrites before stamping `deliveredAt`. Both calls
 * go through this function, so a recomposition differs only where the locale
 * or the rationale genuinely changed.
 *
 * ## Plain text
 *
 * An Art 17 statement is a legal communication, not a marketing email, and a
 * text body is the one shape every client renders identically. Kept from the
 * dispatch job, where that reasoning was first written down.
 */
import type { Locale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';

export interface StatementBody {
    /** The email subject, in `locale`. */
    readonly subject: string;
    /** The full plain-text body, in `locale`. */
    readonly body: string;
}

/**
 * Compose the subject and body for one action, in one locale.
 *
 * `rationale` is read from the `ModerationAction` by every caller rather than
 * taken from a form: it is where a moderator actually wrote the reason, and
 * reading it is what makes the delivered text match the decision.
 *
 * `redressUrl` is interpolated into the redress line (#1667 ruling 2). It is
 * REQUIRED in effect — the line names a page — and defaults to the bare path
 * only so a caller without a configured origin degrades to something a person
 * can still act on rather than to an empty gap in a legal notice.
 */
export async function composeStatementBody(
    locale: Locale,
    actionKind: string,
    rationale: string,
    opts?: { readonly redressUrl?: string },
): Promise<StatementBody> {
    const [subject, intro, actionLine, reasonLabel, redress] = await Promise.all([
        translateFor(locale, 'statementOfReasons.subject'),
        translateFor(locale, 'statementOfReasons.intro'),
        translateFor(locale, `statementOfReasons.action.${actionKind}`),
        translateFor(locale, 'statementOfReasons.reasonLabel'),
        // #1667 ruling 2: the redress line names the `/dsa-contact` page, not
        // "reply to this message". `SMTP_FROM` defaults to
        // `noreply@agrent.bg`, so the old copy promised a reply nobody reads —
        // in the one communication where a broken remedy is itself the
        // compliance failure. The page is already public (`guard.ts` allowlists
        // it) and does not depend on the role mailbox #1599 is blocked on.
        translateFor(locale, 'statementOfReasons.redress', {
            url: opts?.redressUrl ?? DSA_CONTACT_PATH,
        }),
    ]);

    return {
        subject,
        body: [intro, '', actionLine, '', reasonLabel, rationale, '', redress].join('\n'),
    };
}

/** The DSA single point of contact, as a path. Public — see `lib/auth/guard.ts`. */
export const DSA_CONTACT_PATH = '/dsa-contact';

/** Absolute `/dsa-contact` for an email, which cannot resolve a relative path. */
export function dsaContactUrl(appUrl: string | undefined | null): string {
    const base = (appUrl ?? '').replace(/\/+$/, '');
    return base ? `${base}${DSA_CONTACT_PATH}` : DSA_CONTACT_PATH;
}

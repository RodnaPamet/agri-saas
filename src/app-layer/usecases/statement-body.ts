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
import { env } from '@/env';
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
): Promise<StatementBody> {
    const address = resolveRedressAddress();
    const [subject, intro, actionLine, reasonLabel, redress] = await Promise.all([
        translateFor(locale, 'statementOfReasons.subject'),
        translateFor(locale, 'statementOfReasons.intro'),
        translateFor(locale, `statementOfReasons.action.${actionKind}`),
        translateFor(locale, 'statementOfReasons.reasonLabel'),
        // #1667 ruling 2, SECOND attempt — see `resolveRedressAddress`.
        address
            ? translateFor(locale, 'statementOfReasons.redress', { address })
            : translateFor(locale, 'statementOfReasons.redressNoContact'),
    ]);

    return {
        subject,
        body: [intro, '', actionLine, '', reasonLabel, rationale, '', redress].join('\n'),
    };
}

/**
 * The address a suspended person may write to, or `null` if there is none.
 *
 * ## Why this does NOT point at `/dsa-contact`
 *
 * #1667 ruling 2 was "point at `/dsa-contact` instead" of "reply to this
 * message", and my first implementation did exactly that. `agrent-ios` then
 * read production: the page still rendered `dsa.addressUnset` —
 * *"A contact address has not been configured for this deployment"* — because
 * `DSA_CONTACT_EMAIL` was unset, while the page's own body said "Write to the
 * address below" with nothing below it.
 *
 * `DSA_CONTACT_EMAIL` is PRESENT as of 2026-10-13 and the page now renders a
 * `mailto:`, so the dead end described below no longer exists on this
 * deployment. The fallback chain stays, because it is what makes the statement
 * correct on a deployment that has not configured one — and because this
 * instance spent two days in exactly that state.
 *
 * So the statement would have sent a suspended farmer **email → a page with no
 * address → a third page**. That is a worse dead end than the `noreply`
 * promise the ruling was correcting, and it would have gone out automatically
 * on every suspension.
 *
 * The ruling's intent — a redress route that exists — is served better by
 * naming an ADDRESS in the email, with no hop at all:
 *
 *   1. `DSA_CONTACT_EMAIL`      the Art 11/12 single point of contact.
 *   2. `PRIVACY_CONTACT_EMAIL`  a real operator contact, the fallback the
 *                               `/dsa-contact` page itself suggests.
 *   3. neither set              name NO address and promise no human review.
 *
 * Case 3 is the honest one and the point of the whole change: the statement
 * still informs the person of out-of-court and judicial redress, which is true
 * regardless of configuration, and claims nothing that is not. A legal notice
 * that names a channel nobody reads is the defect, not the absence of one.
 *
 * Both variables are `z.string().email().optional()` with no default, and
 * deliberately so — `env.ts` says the controller is the organisation operating
 * the deployment, so an address cannot be baked in.
 */
export function resolveRedressAddress(): string | null {
    return env.DSA_CONTACT_EMAIL ?? env.PRIVACY_CONTACT_EMAIL ?? null;
}

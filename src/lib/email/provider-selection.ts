/**
 * WHICH mail transport this runtime will use — the single decision function.
 *
 * ## Why this is its own module
 *
 * Two callers need the answer and they must never disagree:
 *
 *   • `src/lib/mailer.ts`'s `initMailerFromEnv()` CONSTRUCTS the provider, and
 *   • `/api/readyz` REPORTS it under `capabilities.email`, so an operator can
 *     see which transport a running container actually picked.
 *
 * Before this existed, delivery was provable only by calling Resend's API by
 * hand with the container's env (done 2026-10-01 — two real messages
 * delivered). Nothing proved that `sendEmail` itself selects Resend, and the
 * console sink logged at `debug`, which is silent at production log levels: a
 * silent fallback to "discard the message" was indistinguishable from success.
 *
 * A reporter that re-derives the branch would drift from the constructor the
 * first time a third transport lands. So the branch lives HERE, once, and both
 * sides call it.
 *
 * ## Why no `@/env` import
 *
 * `mailer.ts` deliberately requires `@/env` lazily (Next's bundler loads
 * mailer.ts in several chunks, and env validation at module-parse time in each
 * of them is a hazard it already paid for). Keeping this module a pure function
 * of its argument means importing it pulls in nothing at all — each caller
 * passes the env object it already holds, so adding a transport changes the
 * type and this one function, never a field list at two call sites.
 *
 * @module lib/email/provider-selection
 */

/** The transports `initMailerFromEnv()` can select. A closed enum. */
export type MailProviderKind = 'resend' | 'smtp' | 'console';

/**
 * The env fields the decision reads. A structural subset of `@/env`'s parsed
 * env, so callers pass `env` whole rather than plumbing individual fields.
 */
export interface MailProviderEnv {
    RESEND_API_KEY?: string | undefined;
    SMTP_HOST?: string | undefined;
}

/**
 * Resend (HTTPS API) wins when its key is set — it needs no SMTP egress, and
 * it is what production runs on. SMTP is the dormant fallback: still wired,
 * still configured on the VM, used only when `RESEND_API_KEY` is absent.
 *
 * With neither set the caller keeps the console sink, which DISCARDS mail.
 */
export function selectMailProviderKind(e: MailProviderEnv): MailProviderKind {
    if (e.RESEND_API_KEY) return 'resend';
    if (e.SMTP_HOST) return 'smtp';
    return 'console';
}

/** Operator-facing mail status, as reported by `/api/readyz`. */
export interface EmailCapabilityStatus {
    /** Which transport is configured — never a key, never a host. */
    provider: MailProviderKind;
    /**
     * False only for `console`, where messages are logged and thrown away.
     * A boolean because that is the question an operator or a dashboard asks:
     * is mail leaving this container at all?
     */
    sends: boolean;
}

/**
 * The `/api/readyz` `capabilities.email` payload.
 *
 * This reports what is CONFIGURED, which is the honest answer a probe can
 * give: the web tier initialises the mailer lazily per bundler chunk, so the
 * provider instance live in the probe's own chunk is not evidence about the
 * chunk that sends an invite. Both, however, branch on this same function —
 * so "configured" and "selected" cannot diverge.
 *
 * Deliberately OUTSIDE the probe's `checks`/`failed` surfaces: mail is a
 * degradable capability and must never 503 a healthy instance.
 */
export function emailCapabilityStatus(e: MailProviderEnv): EmailCapabilityStatus {
    const provider = selectMailProviderKind(e);
    return { provider, sends: provider !== 'console' };
}

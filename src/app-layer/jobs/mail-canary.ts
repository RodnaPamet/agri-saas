/**
 * Mail canary (P3.10) — prove the send path still works, every six hours.
 *
 * ── what this catches that nothing else does ──
 *
 * The mailer already handles the case where NO transport is configured:
 * `ConsoleEmailProvider` warns loudly in production and `/api/readyz` reports
 * `capabilities.email`. What neither catches is a transport that WAS working
 * and has stopped — a revoked Resend key, a domain whose verification lapsed,
 * an exhausted quota, a provider outage.
 *
 * That failure is currently invisible until a farmer complains. `sendEmail`
 * catches its own errors at every call site (deliberately: a mailer failure
 * must not fail a signup), so a broken key means every verification email
 * silently fails and the only trace is a log line nobody is watching. Since
 * P3.5b, email verification stands between a farmer and their farm — so a
 * dead send path is now a dead front door.
 *
 * ── the trap this job exists to avoid falling into ──
 *
 * The naive canary calls `sendEmail`, sees no exception, and reports healthy.
 * That is wrong in exactly the configuration that matters most:
 * `ConsoleEmailProvider` does NOT throw. It logs a warning and discards the
 * message. So a canary that only watched for a thrown error would report
 * green on a deployment sending no mail at all — a control that cannot
 * express the failure it exists to detect.
 *
 * Hence the provider check BEFORE the send. `NOT_CONFIGURED` is a distinct
 * outcome from `FAILED`, and both are distinct from `SENT`.
 *
 * ── what it does NOT prove, which matters more than what it does ──
 *
 * It proves the provider ACCEPTED the message. It does not prove delivery.
 * Nothing here reads an inbox, so an accepted-then-bounced message, a
 * spam-foldered one, or a silently-dropped one all look like success.
 *
 * Calling this a "delivery check" would be the dangerous reading: an operator
 * who believed that would stop investigating "the farmer says no email
 * arrived" because the canary is green. It is a SEND-PATH check. The bounce
 * half needs a webhook from the provider, which is a different piece of work.
 */
import { getEmailProvider, sendEmail, ConsoleEmailProvider, StubEmailProvider } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';

export type MailCanaryOutcome =
    /** A real transport accepted the message. */
    | 'SENT'
    /** No `MAIL_CANARY_TO` — the canary itself is not set up. */
    | 'SKIPPED_NO_RECIPIENT'
    /** A transport is configured in name only: the console/stub sink is live. */
    | 'NOT_CONFIGURED'
    /** A real transport rejected or could not be reached. */
    | 'FAILED';

export interface MailCanaryResult {
    outcome: MailCanaryOutcome;
    /** Provider class name, for the log. Never credentials. */
    provider: string;
    /** Error message when FAILED. Truncated; never the API key. */
    detail?: string;
}

export interface MailCanaryOptions {
    /** Override the recipient — test-only seam. */
    to?: string | null;
    /** Override the clock for the subject line — test-only seam. */
    now?: Date;
}

/** So the "not set up" warning is loud once per process, not once per run. */
let warnedNoRecipient = false;

/** Reset the once-per-process warning. Test-only seam. */
export function __resetMailCanaryWarning(): void {
    warnedNoRecipient = false;
}

export async function runMailCanary(
    options: MailCanaryOptions = {},
): Promise<MailCanaryResult> {
    const to = options.to !== undefined ? options.to : process.env.MAIL_CANARY_TO || null;
    const provider = getEmailProvider();
    const providerName = provider.constructor.name;

    if (!to) {
        if (!warnedNoRecipient) {
            warnedNoRecipient = true;
            logger.warn('mail-canary.no_recipient', {
                component: 'jobs',
                event: 'mail_canary_no_recipient',
                // Phrased for whoever reads logs after a deploy. A silent skip
                // is indistinguishable from a passing canary, which is the
                // whole failure mode this job is built around.
                detail:
                    'MAIL_CANARY_TO is unset, so the mail send path is NOT being monitored. Set it to an address somebody actually reads; a canary nobody receives proves nothing.',
            });
        }
        return { outcome: 'SKIPPED_NO_RECIPIENT', provider: providerName };
    }

    // BEFORE the send, and this ordering is the point. The console sink does
    // not throw — it warns and discards — so a canary that sent first and
    // watched for an exception would report SENT on a deployment mailing
    // nothing. See the file docblock.
    if (provider instanceof ConsoleEmailProvider || provider instanceof StubEmailProvider) {
        logger.error('mail-canary.not_configured', {
            component: 'jobs',
            event: 'mail_canary_not_configured',
            provider: providerName,
            detail:
                'The active mail provider is a sink, not a transport. Verification emails are being discarded. Set RESEND_API_KEY (preferred) or SMTP_HOST.',
        });
        return { outcome: 'NOT_CONFIGURED', provider: providerName };
    }

    const stamp = (options.now ?? new Date()).toISOString();
    try {
        await sendEmail({
            to,
            // The timestamp is in the subject deliberately: a reader can tell
            // a live canary from one that stopped six hours ago without
            // opening it, and successive canaries do not collapse into one
            // threaded conversation.
            subject: `Agrent mail canary ${stamp}`,
            text: [
                'This is an automated check that the Agrent mail send path works.',
                '',
                'It proves the provider ACCEPTED this message. It does not prove',
                'delivery — if you are reading it, that is the stronger signal.',
                '',
                `Sent: ${stamp}`,
                `Provider: ${providerName}`,
            ].join('\n'),
        });
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error('mail-canary.failed', {
            component: 'jobs',
            event: 'mail_canary_failed',
            provider: providerName,
            // Truncated: a provider error body can be long, and the key is
            // never in the message — `ResendProvider` throws
            // `Resend API error <status>: <body>` with the body already
            // sliced, and the Authorization header is not echoed.
            detail: detail.slice(0, 300),
        });
        return { outcome: 'FAILED', provider: providerName, detail: detail.slice(0, 300) };
    }

    logger.info('mail-canary.sent', {
        component: 'jobs',
        event: 'mail_canary_sent',
        provider: providerName,
    });
    return { outcome: 'SENT', provider: providerName };
}

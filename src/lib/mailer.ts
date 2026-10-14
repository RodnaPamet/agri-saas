/**
 * Email provider abstraction.
 *
 * Providers:
 * - ConsoleEmailProvider: logs to console (dev default; WARNs in production,
 *                         where it means the message was discarded)
 * - ResendProvider:       sends via Resend's HTTPS API (what production runs)
 * - NodemailerProvider:   sends via SMTP (dormant fallback)
 * - StubEmailProvider:    records messages for tests
 *
 * Which one is selected is decided in ONE place —
 * `src/lib/email/provider-selection.ts` — shared with `/api/readyz`, so the
 * probe's `capabilities.email` cannot drift from what `sendEmail` does.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '@/lib/observability/logger';
import { selectMailProviderKind } from '@/lib/email/provider-selection';

export interface EmailAttachment {
    filename: string;
    content: Buffer;
    contentType?: string;
}

export interface EmailMessage {
    to: string;
    subject: string;
    text: string;
    html?: string;
    from?: string;   // Override default sender
    bcc?: string;    // Compliance mailbox BCC
    /**
     * Where a reply should go, when that is not the sender (#1667).
     *
     * Added for the DSA Art 17 statement of reasons, which names an address a
     * person may write to for redress. The sender is the deployment's
     * `RESEND_FROM`/`SMTP_FROM`, and a person who hits Reply rather than
     * copying the address out of the body lands there — which on this
     * deployment BOUNCES, because every `agrent.bg` recipient does (#1760).
     * So the redress route the notice names worked and the one a person
     * actually uses did not.
     *
     * Optional, and unset everywhere else on purpose: for ordinary mail the
     * sender IS the right reply target, and a blanket `replyTo` would reroute
     * conversations nobody asked to move.
     */
    replyTo?: string;
    attachments?: EmailAttachment[];  // RQ-10 — e.g. a generated report artefact
}

export interface EmailProvider {
    /**
     * Put one message on the wire.
     *
     * Returns the provider's message id where it has one, so `sendEmail` can
     * log something an operator can look up (#1753). `null` is a legitimate
     * answer — the console sink and SMTP have no such id — and callers must
     * not treat its absence as failure.
     *
     * **Resolving says the provider ACCEPTED the message, never that it was
     * delivered.** Delivery is asynchronous and arrives as a bounce or a
     * webhook minutes later, so no return value here can report it. That
     * distinction is not pedantry: a DSA alert resolved here, was marked sent,
     * and bounced (#1753).
     */
    send(msg: EmailMessage): Promise<string | null | void>;
}

// ─── Console (dev) ───

/**
 * Is this process running in production?
 *
 * Lazy `require` of `@/env` for the same reason `initMailerFromEnv` does it
 * (see its comment): Next's bundler loads mailer.ts in several chunks and this
 * module must not drag env validation in at parse time in each of them.
 */
function isProductionRuntime(): boolean {

    const { env } = require('@/env');
    return env.NODE_ENV === 'production';
}

export class ConsoleEmailProvider implements EmailProvider {
    async send(msg: EmailMessage): Promise<void> {
        if (isProductionRuntime()) {
            // The console sink in PRODUCTION means no transport was configured
            // and this message is being THROWN AWAY. It used to say so at
            // `debug`, which production log levels drop — so a silent fallback
            // to "discard the mail" looked exactly like a successful send, for
            // invites, password resets and the notification outbox alike.
            //
            // The body is deliberately NOT logged on this path, unlike the dev
            // line below: these messages carry verification + password-reset
            // links, and a WARN that survives production log levels is a WARN
            // that reaches log storage.
            logger.warn('Email NOT SENT — no mail transport configured; the console sink discarded it', {
                component: 'mailer',
                provider: 'console',
                delivered: false,
                to: msg.to,
                subject: msg.subject,
                hint: 'Set RESEND_API_KEY (preferred) or SMTP_HOST. /api/readyz reports capabilities.email.',
            });
            return;
        }
        // Dev/test: the console sink is the intended default, so stay at
        // `debug` and keep local development quiet.
        logger.debug('Email sent (dev console sink)', {
            component: 'mailer',
            to: msg.to,
            subject: msg.subject,
            bodyPreview: msg.text.substring(0, 200),
            ...(msg.from && { from: msg.from }),
            ...(msg.bcc && { bcc: msg.bcc }),
            ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => a.filename) } : {}),
        });
    }
}

// ─── Nodemailer (production SMTP) ───

export class NodemailerProvider implements EmailProvider {
    private transporter: Transporter;

    constructor(config: { host: string; port: number; user?: string; pass?: string; from: string }) {
        this.transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.port === 465,
            ...(config.user && config.pass
                ? { auth: { user: config.user, pass: config.pass } }
                : {}),
        });
        this.from = config.from;
    }

    private from: string;

    async send(msg: EmailMessage): Promise<void> {
        await this.transporter.sendMail({
            from: msg.from || this.from,
            to: msg.to,
            subject: msg.subject,
            text: msg.text,
            ...(msg.html ? { html: msg.html } : {}),
            ...(msg.bcc ? { bcc: msg.bcc } : {}),
            // nodemailer's own field name, not `reply_to`.
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.attachments ? { attachments: msg.attachments } : {}),
        });
    }
}

// ─── Resend (HTTPS API) ───

export class ResendProvider implements EmailProvider {
    constructor(
        private apiKey: string,
        private from: string,
    ) {}

    async send(msg: EmailMessage): Promise<string | null> {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: msg.from || this.from,
                to: msg.to,
                subject: msg.subject,
                text: msg.text,
                ...(msg.html ? { html: msg.html } : {}),
                ...(msg.bcc ? { bcc: msg.bcc } : {}),
                // Resend's API spells it `reply_to`, NOT `replyTo` — an
                // unknown key is accepted and ignored, so getting this wrong
                // fails silently and looks exactly like success.
                ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
                ...(msg.attachments
                    ? {
                          attachments: msg.attachments.map((a) => ({
                              filename: a.filename,
                              content: a.content.toString('base64'),
                          })),
                      }
                    : {}),
            }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Resend API error ${res.status}: ${detail.slice(0, 300)}`);
        }

        // The message id, which the success body carries and this used to
        // DISCARD (#1753).
        //
        // On 2026-10-13 a DSA Art 16 alert resolved successfully here, the job
        // stamped `alertedAt`, and the message BOUNCED minutes later —
        // `550 … dsa@agrent.bg … account or domain may not exist`. Diagnosing
        // that needed a live API call from inside the running container,
        // because nothing in the product had recorded which message to ask
        // about. With the id it is one lookup.
        //
        // Returned rather than logged here so the provider stays a transport:
        // `sendEmail` owns the logging, and a provider that logged would log
        // twice for callers that already do.
        // Defensive on BOTH the call and the shape. A transport double that
        // predates this change supplies `{ ok, status, text }` and no `json`
        // — measured: two existing suites in `mailer.test.ts` died with
        // `res.json is not a function` the moment this read was added. A
        // provider must not break because a response object is sparser than
        // expected, and an absent id is already a legitimate answer.
        const body = (await (typeof res.json === 'function'
            ? res.json().catch(() => null)
            : Promise.resolve(null))) as { id?: string } | null;
        return typeof body?.id === 'string' ? body.id : null;
    }
}

// ─── Stub (tests) ───

export class StubEmailProvider implements EmailProvider {
    public sentMessages: EmailMessage[] = [];

    async send(msg: EmailMessage): Promise<void> {
        this.sentMessages.push(msg);
    }

    reset(): void {
        this.sentMessages = [];
    }
}

// ─── Singleton ───

let provider: EmailProvider = new ConsoleEmailProvider();
let envInitAttempted = false;

export function setEmailProvider(p: EmailProvider) {
    provider = p;
}

export function getEmailProvider(): EmailProvider {
    return provider;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
    // Lazy, per-module-instance init from env. Next's bundler can load
    // mailer.ts in a DIFFERENT chunk for a route handler than the one
    // `instrumentation.ts` initialized at startup, leaving the route's
    // copy on the default console sink — so emails (invites, etc.)
    // silently no-op even though SMTP is configured. Initialize on the
    // first real send so whichever instance actually sends picks up
    // SMTP from env. Guarded on the provider still being the console
    // default, so a caller that explicitly set a provider (tests' stub,
    // or a manual setEmailProvider) is never overridden.
    if (!envInitAttempted && provider instanceof ConsoleEmailProvider) {
        envInitAttempted = true;
        initMailerFromEnv();
    }
    // ── Per-message logging (#1753) ──
    //
    // This function was `await provider.send(msg)` and nothing else: no log,
    // no try/catch, no record of the message. The only mailer log in the whole
    // system was "Mailer transport selected" at startup, so a failed send and
    // a successful one were the same observable, and the provider's message id
    // — the one thing that makes a delivery failure diagnosable — was thrown
    // away.
    //
    // That is not hypothetical. On 2026-10-13 a DSA Art 16 alert resolved
    // here, `notice-triage-alert` stamped `alertedAt`, and the message bounced
    // minutes later. Finding out why needed a Resend API call from inside the
    // running container, because the product had recorded nothing.
    //
    // **The recipient DOMAIN, never the address.** Epic C.4's rule is that an
    // audit actor is an opaque id and never an email, and a log line naming
    // who was invited, who reported what, or who asked to be deleted is the
    // disclosure this product spends most of its design avoiding. The domain
    // is enough to tell "the DSA mailbox" from "a farmer's inbox", which is
    // the operational question.
    const recipientDomain = msg.to.includes('@') ? msg.to.slice(msg.to.lastIndexOf('@') + 1) : 'unknown';
    const started = Date.now();
    try {
        const id = (await provider.send(msg)) ?? null;
        logger.info('mail.sent', {
            component: 'mailer',
            provider: providerName(provider),
            recipientDomain,
            // The provider's handle, so a bounce is a lookup rather than an
            // investigation. `null` for transports that mint none.
            messageId: typeof id === 'string' ? id : null,
            durationMs: Date.now() - started,
        });
    } catch (err) {
        // Logged AND rethrown. The callers' retry semantics depend on this
        // throwing — `notice-triage-alert` stamps `alertedAt` only after
        // `sendEmail` resolves, precisely so a failure retries — so swallowing
        // here would convert a loud failure into the silent one this change
        // exists to end.
        logger.error('mail.send_failed', {
            component: 'mailer',
            provider: providerName(provider),
            recipientDomain,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}

/**
 * The transport's name for a log line, derived from the instance rather than
 * re-read from env — so the log says what is ACTUALLY sending, which is the
 * question `/api/readyz`'s `capabilities.email` answers for the operator and
 * this answers per message.
 */
function providerName(p: EmailProvider): string {
    if (p instanceof ResendProvider) return 'resend';
    if (p instanceof ConsoleEmailProvider) return 'console';
    if (p instanceof StubEmailProvider) return 'stub';
    return p.constructor?.name ?? 'unknown';
}

/**
 * Initialize the provider from environment variables.
 * Call once at app startup (e.g., in instrumentation.ts or server init).
 *
 * Uses the validated env module (not raw env vars).
 */
/**
 * Built-in fallback sender. Kept in sync with the SMTP_FROM default in
 * src/env.ts. Production should ALWAYS set RESEND_FROM / SMTP_FROM to a
 * verified sender on its own domain — this default is a dev convenience, and
 * `initMailerFromEnv` warns when prod runs on it (deliverability suffers when
 * the From address isn't a domain the operator practices / has SPF+DKIM for).
 */
const DEFAULT_SENDER = 'noreply@agrent.bg';

export function initMailerFromEnv(): void {
    // Dynamic import to avoid circular deps at module parse time

    const { env } = require('@/env');

    // Warn once if production falls back to the built-in default sender —
    // neither RESEND_FROM nor SMTP_FROM was set to an operator-owned address.
    const usingDefaultSender = !env.RESEND_FROM && (!env.SMTP_FROM || env.SMTP_FROM === DEFAULT_SENDER);
    if (env.NODE_ENV === 'production' && usingDefaultSender) {
        logger.warn('Mailer using the built-in default sender in production', {
            component: 'mailer',
            sender: DEFAULT_SENDER,
            hint: 'Set RESEND_FROM or SMTP_FROM to a verified sender on your own domain.',
        });
    }

    // ONE decision function, shared with /api/readyz's capabilities.email —
    // see src/lib/email/provider-selection.ts. Resend (HTTPS API) takes
    // precedence: it needs no SMTP egress and it is what production runs on.
    // SMTP stays wired as the dormant fallback.
    const kind = selectMailProviderKind(env);

    if (kind === 'resend') {
        // RESEND_FROM must be a Resend-verified sender; falls back to
        // SMTP_FROM (which carries a default).
        setEmailProvider(
            new ResendProvider(env.RESEND_API_KEY, env.RESEND_FROM ?? env.SMTP_FROM ?? DEFAULT_SENDER),
        );
    } else if (kind === 'smtp') {
        const port = env.SMTP_PORT ?? 587;
        const user = env.SMTP_USER;
        const pass = env.SMTP_PASS;
        const from = env.SMTP_FROM ?? DEFAULT_SENDER;
        setEmailProvider(new NodemailerProvider({ host: env.SMTP_HOST, port, user, pass, from }));
    }
    // 'console' → keep ConsoleEmailProvider (dev/test default). In production
    // that sink WARNs on every send that the message was discarded.

    // Name the selected transport in the logs. Delivery was previously
    // provable only from outside the app (calling Resend by hand with the
    // container's env); this line is the inside-the-app evidence that
    // `sendEmail` picked the transport the operator configured. No key
    // material — the kind is a closed enum.
    logger.info('Mailer transport selected', {
        component: 'mailer',
        provider: kind,
        sends: kind !== 'console',
    });
}

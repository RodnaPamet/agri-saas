/**
 * Email provider abstraction.
 *
 * Providers:
 * - ConsoleEmailProvider: logs to console (dev default)
 * - NodemailerProvider:   sends via SMTP (production)
 * - StubEmailProvider:    records messages for tests
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { logger } from '@/lib/observability/logger';

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
    attachments?: EmailAttachment[];  // RQ-10 — e.g. a generated report artefact
}

export interface EmailProvider {
    send(msg: EmailMessage): Promise<void>;
}

// ─── Console (dev) ───

export class ConsoleEmailProvider implements EmailProvider {
    async send(msg: EmailMessage): Promise<void> {
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

    async send(msg: EmailMessage): Promise<void> {
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
    await provider.send(msg);
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

    // Resend (HTTPS API) takes precedence — most deployments use it and it
    // needs no SMTP egress. RESEND_FROM must be a Resend-verified sender;
    // falls back to SMTP_FROM (which carries a default).
    const resendKey = env.RESEND_API_KEY;
    if (resendKey) {
        setEmailProvider(
            new ResendProvider(resendKey, env.RESEND_FROM ?? env.SMTP_FROM ?? DEFAULT_SENDER),
        );
        return;
    }

    const host = env.SMTP_HOST;
    if (host) {
        const port = env.SMTP_PORT ?? 587;
        const user = env.SMTP_USER;
        const pass = env.SMTP_PASS;
        const from = env.SMTP_FROM ?? DEFAULT_SENDER;
        setEmailProvider(new NodemailerProvider({ host, port, user, pass, from }));
    }
    // Otherwise keep ConsoleEmailProvider (dev/test default)
}

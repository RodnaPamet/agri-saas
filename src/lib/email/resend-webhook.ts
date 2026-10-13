/**
 * Verify and parse a Resend webhook (#1753).
 *
 * ## Why this exists
 *
 * A message can be ACCEPTED by the provider, logged as sent, and never
 * arrive. On 2026-10-13 that happened three times to DSA Art 16 alerts:
 * `sendEmail` resolved, `notice-triage-alert` stamped `alertedAt`, and each
 * bounced minutes later with `550 … the account or domain may not exist`.
 * Nothing in the product knew, and diagnosing it needed a Resend API call from
 * inside the running container.
 *
 * **No amount of logging at the call site can fix that.** Delivery is
 * asynchronous: the send returns before the receiving server has decided. The
 * only way a bounce reaches the product is for the provider to tell it, which
 * is what this endpoint is for.
 *
 * ## Svix, hand-rolled, and why that is proportionate
 *
 * Resend signs with Svix. The scheme is small and fully specified, and the AV
 * webhook already hand-rolls HMAC verification in this codebase — adding a
 * dependency to compute one HMAC would be the larger change, and a dependency
 * in the request path of a public endpoint is not free.
 *
 *   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   expected      = base64(HMAC-SHA256(key, signedContent))
 *   key           = base64-decoded secret, after stripping `whsec_`
 *
 * `svix-signature` carries SPACE-SEPARATED versioned entries (`v1,<sig>`), so
 * a secret rotation can present two at once. Any `v1` match is a pass, and
 * every comparison is timing-safe.
 *
 * ## The raw body is the signed input
 *
 * It must not be parsed before verification — the signature is over the bytes.
 * That is the same constraint `/api/stripe/webhook` records, and the reason
 * both routes read `req.text()` rather than `req.json()`.
 */
import crypto from 'crypto';

/**
 * How far a timestamp may drift before the request is refused.
 *
 * Svix's own tolerance. A signature with no freshness bound is replayable for
 * ever: an attacker who captures one valid delivery could resend it
 * indefinitely, and for a bounce feed that means forging the claim that a
 * message failed — which, once the correlation half lands, would be a way to
 * make the platform retry sends on demand.
 */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerdict =
    | { ok: true }
    | { ok: false; reason: 'no-secret' | 'missing-headers' | 'stale' | 'bad-signature' };

export function verifyResendSignature(input: {
    rawBody: string;
    svixId: string | null;
    svixTimestamp: string | null;
    svixSignature: string | null;
    secret: string | null | undefined;
    nowSeconds?: number;
}): WebhookVerdict {
    const { rawBody, svixId, svixTimestamp, svixSignature, secret } = input;

    // Unconfigured is NOT a pass. The endpoint is public, so with no secret
    // there is nothing to distinguish Resend from anyone else — it refuses
    // rather than trusting the body, the same fail-closed posture the other
    // signed webhooks take.
    if (!secret) return { ok: false, reason: 'no-secret' };
    if (!svixId || !svixTimestamp || !svixSignature) {
        return { ok: false, reason: 'missing-headers' };
    }

    const ts = Number(svixTimestamp);
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > SVIX_TOLERANCE_SECONDS) {
        return { ok: false, reason: 'stale' };
    }

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = crypto
        .createHmac('sha256', key)
        .update(`${svixId}.${svixTimestamp}.${rawBody}`)
        .digest('base64');

    // Space-separated `v<n>,<signature>` entries. Unknown versions are
    // ignored rather than refused, so a future `v2` alongside `v1` does not
    // break a working integration.
    const candidates = svixSignature
        .split(' ')
        .map((part) => part.split(','))
        .filter(([version]) => version === 'v1')
        .map(([, sig]) => sig)
        .filter((s): s is string => Boolean(s));

    const expectedBuf = Buffer.from(expected);
    for (const candidate of candidates) {
        const candidateBuf = Buffer.from(candidate);
        if (candidateBuf.length !== expectedBuf.length) continue;
        if (crypto.timingSafeEqual(candidateBuf, expectedBuf)) return { ok: true };
    }
    return { ok: false, reason: 'bad-signature' };
}

/** The event shapes this endpoint acts on. Everything else is acknowledged and ignored. */
export const FAILURE_EVENTS = ['email.bounced', 'email.complained', 'email.failed'] as const;
export type FailureEvent = (typeof FAILURE_EVENTS)[number];

export interface ParsedDeliveryEvent {
    type: string;
    /** Resend's message id — the handle `mail.sent` already logs. */
    messageId: string | null;
    /** Recipient DOMAIN only. Never the address — Epic C.4. */
    recipientDomain: string | null;
    /** A short, bounded reason. Never the message body. */
    reason: string | null;
    isFailure: boolean;
}

export function parseDeliveryEvent(payload: unknown): ParsedDeliveryEvent | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const type = typeof p.type === 'string' ? p.type : null;
    if (!type) return null;

    const data = (p.data ?? {}) as Record<string, unknown>;
    const to = Array.isArray(data.to) ? data.to : [];
    const first = typeof to[0] === 'string' ? to[0] : null;

    const bounce = (data.bounce ?? {}) as Record<string, unknown>;
    // The provider's own words, truncated. Enough to tell a hard bounce from a
    // mailbox-full, which is the operational question; not enough to carry
    // content.
    const reason = typeof bounce.subType === 'string'
        ? `${String(bounce.type ?? 'unknown')}/${bounce.subType}`
        : null;

    return {
        type,
        messageId: typeof data.email_id === 'string' ? data.email_id
            : typeof p.id === 'string' ? p.id : null,
        recipientDomain: first && first.includes('@')
            ? first.slice(first.lastIndexOf('@') + 1)
            : null,
        reason,
        isFailure: (FAILURE_EVENTS as readonly string[]).includes(type),
    };
}

/**
 * Send a notification to an iPhone over APNs — #1764 step 3, P7.4 (#1993).
 *
 * ## Inert until a key is installed
 *
 * `isApnsConfigured()` requires four values, and with any of them absent every
 * send returns without touching the network. That is deliberate rather than
 * defensive: this module ships before the key exists, so an unconfigured
 * deployment must be a no-op and not an error — and a self-hosted deploy that
 * never wants push should stay clean, the same way VAPID gates web push.
 *
 * ## The provider token, and why it is cached
 *
 * APNs authenticates each request with a short ES256 JWT, and Apple is
 * specific about its lifetime in both directions (confirmed from the client
 * side by agrent-ios, 2026-10-20):
 *
 *   - older than one hour → 403 `ExpiredProviderToken`
 *   - minted per request  → 429 `TooManyProviderTokenUpdates`
 *
 * So neither "sign every time" nor "sign once at boot" works. It is cached per
 * process and re-minted after {@link PROVIDER_TOKEN_TTL_SECONDS}, comfortably
 * inside the hour and comfortably above the per-request rate.
 *
 * ## The signature format is the part that silently fails
 *
 * `crypto.sign` emits DER by default; a JWS ES256 signature is the raw
 * `r || s` pair (IEEE P1363). A DER signature is well-formed, base64url-encodes
 * cleanly, and produces a token Apple rejects — which reads like a wrong Key
 * ID and sends you to the wrong place entirely.
 *
 * `src/lib/auth/apple-client-secret.ts` records the same trap for Sign in with
 * Apple, and that duplication is deliberate: extracting one signer would mean
 * refactoring untested code on the sign-in path as a side effect of a push
 * change, and a subtle error there lands on the thing nobody can log in with.
 * #2075 tracks testing that module; one signer is the right end state after it
 * has tests, not before.
 *
 * ## The host is per ROW, not per deployment
 *
 * A token is only valid in the environment it was issued for, so one
 * deployment serving a development-signed install and a TestFlight build must
 * send to two different hosts. `PushSubscription.apnsEnvironment` carries
 * which; a row with none is refused and logged rather than guessed, because a
 * guess fails as `BadDeviceToken` — indistinguishable from a revoked token,
 * so the pruning below would delete a working registration.
 */
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

/**
 * Re-mint after 30 minutes. Apple's window is 20 to 60; the middle avoids both
 * ends, and nothing here depends on the exact figure.
 */
export const PROVIDER_TOKEN_TTL_SECONDS = 30 * 60;

/** The two hosts. A token is valid at exactly one of them. */
export const APNS_HOSTS = {
    DEVELOPMENT: 'api.sandbox.push.apple.com',
    PRODUCTION: 'api.push.apple.com',
} as const;

export function isApnsConfigured(): boolean {
    return Boolean(
        env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC && env.APNS_PRIVATE_KEY,
    );
}

function b64url(input: Buffer | string): string {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * A `.p8` pasted into an env var usually arrives with its newlines escaped,
 * because a PEM is multi-line and `.env` is not. Both forms are accepted —
 * `createPrivateKey` rejects the escaped one with `error:0909006C:PEM routines`,
 * which names nothing about newlines.
 */
function normalisePem(raw: string): string {
    return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

let cached: { token: string; mintedAt: number } | null = null;

/** Test seam — the cache is module state. */
export function _clearApnsProviderToken(): void {
    cached = null;
}

/**
 * The provider token, minted or reused.
 *
 * Null when unconfigured or when the key will not load. Null rather than a
 * throw for the reason the Apple secret gives: a malformed key must leave the
 * rest of the application working, and the operator needs something to read.
 */
export function apnsProviderToken(now = Date.now()): string | null {
    if (!isApnsConfigured()) return null;

    const ageSeconds = cached ? (now - cached.mintedAt) / 1000 : Infinity;
    if (cached && ageSeconds < PROVIDER_TOKEN_TTL_SECONDS) return cached.token;

    const issuedAt = Math.floor(now / 1000);
    // No `aud`, no `sub` and no `exp`: APNs reads `iss` and `iat` and applies
    // its own one-hour window. An `exp` is not rejected but is not what bounds
    // the token, so adding one would imply a control this does not have.
    const header = { alg: 'ES256', kid: env.APNS_KEY_ID };
    const payload = { iss: env.APNS_TEAM_ID, iat: issuedAt };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

    try {
        const key = createPrivateKey(normalisePem(env.APNS_PRIVATE_KEY!));
        const signature = cryptoSign('sha256', Buffer.from(signingInput), {
            key,
            // See the file docblock — DER here passes every local check and is
            // refused by Apple.
            dsaEncoding: 'ieee-p1363',
        });
        cached = { token: `${signingInput}.${b64url(signature)}`, mintedAt: now };
        return cached.token;
    } catch (err) {
        logger.error('apns.provider_token_mint_failed', {
            component: 'apns',
            error: err instanceof Error ? err.message : String(err),
            message:
                'APNS_PRIVATE_KEY did not load as a PKCS#8 EC key. iOS push stays OFF; '
                + 'web push and the rest of the application are unaffected.',
        });
        return null;
    }
}

export interface ApnsPayload {
    title: string;
    body: string;
    /**
     * Where a tap should go, as a ROOT-RELATIVE path.
     *
     * Relative for the same reason `logoUrl` is: the server owns the shape, so
     * correcting it never needs a client release, and the phone already
     * refuses anything that is not relative. agrent-ios #317 opens this
     * through the app's router.
     */
    link?: string;
    /** Coalescing key — a newer push with the same value replaces the old. */
    collapseId?: string;
}

/** One device's row, as the sender needs it. */
interface DeviceRow {
    id: string;
    deviceToken: string;
    apnsEnvironment: 'DEVELOPMENT' | 'PRODUCTION' | null;
}

/**
 * Send to every iPhone the recipient has registered in this tenant.
 *
 * Best-effort and never throws, like `sendWebPushToUser`: a notification is a
 * courtesy on top of a record that is already written, and a push failure must
 * not fail the operation that triggered it.
 */
export async function sendApnsToUser(
    ctx: RequestContext,
    recipientUserId: string,
    payload: ApnsPayload,
): Promise<void> {
    if (!isApnsConfigured()) return;

    let rows: DeviceRow[] = [];
    try {
        rows = await runInTenantContext(ctx, (db) =>
            db.pushSubscription.findMany({
                // `platform: 'IOS'` is load-bearing, not tidiness: this table
                // holds Web Push rows too, and they have no device token.
                where: { userId: recipientUserId, platform: 'IOS', deviceToken: { not: null } },
                select: { id: true, deviceToken: true, apnsEnvironment: true },
            }),
        ) as DeviceRow[];
    } catch (err) {
        logger.warn('apns.device_read_failed', {
            component: 'apns',
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    if (rows.length === 0) return;

    const token = apnsProviderToken();
    if (!token) return;

    /** Tokens APNs reported as gone. Pruned together, after the sends. */
    const dead: string[] = [];

    for (const row of rows) {
        if (!row.apnsEnvironment) {
            // Refused rather than guessed. See the file docblock: a guess is
            // wrong half the time and its failure is indistinguishable from a
            // revoked token, so guessing would get a working row pruned.
            logger.warn('apns.row_has_no_environment', {
                component: 'apns',
                subscriptionId: row.id,
                message:
                    'This device registered before it reported an APNs environment, or its '
                    + 'client does not send one. It will receive nothing until it '
                    + 're-registers.',
            });
            continue;
        }

        const outcome = await deliver(row, token, payload);
        if (outcome === 'gone') dead.push(row.deviceToken);
    }

    if (dead.length > 0) await pruneDeadTokens(ctx, dead);
}

/** The result of one send, reduced to what the caller acts on. */
type Outcome = 'sent' | 'gone' | 'failed';

async function deliver(row: DeviceRow, providerToken: string, payload: ApnsPayload): Promise<Outcome> {
    const host = APNS_HOSTS[row.apnsEnvironment!];
    const body = {
        aps: {
            alert: { title: payload.title, body: payload.body },
            sound: 'default',
        },
        // Custom keys sit beside `aps`, never inside it. `link` is the one the
        // app reads; see ApnsPayload for why it is root-relative.
        ...(payload.link ? { link: payload.link } : {}),
    };

    try {
        const res = await fetch(`https://${host}/3/device/${row.deviceToken}`, {
            method: 'POST',
            headers: {
                authorization: `bearer ${providerToken}`,
                'apns-topic': env.APNS_TOPIC!,
                'apns-push-type': 'alert',
                ...(payload.collapseId ? { 'apns-collapse-id': payload.collapseId } : {}),
            },
            body: JSON.stringify(body),
        });

        if (res.ok) return 'sent';

        // 410 Unregistered is the ONE status that means the token is dead
        // rather than the request being wrong. 400 BadDeviceToken can mean a
        // malformed token OR the right token sent to the wrong environment,
        // so it is deliberately NOT treated as gone — pruning on it would
        // delete working registrations whenever a host was misconfigured.
        if (res.status === 410) {
            logger.info('apns.token_unregistered', {
                component: 'apns',
                subscriptionId: row.id,
                environment: row.apnsEnvironment,
            });
            return 'gone';
        }

        logger.warn('apns.send_failed', {
            component: 'apns',
            subscriptionId: row.id,
            status: res.status,
            environment: row.apnsEnvironment,
            // The reason STRING, which names the cause (ExpiredProviderToken,
            // TooManyProviderTokenUpdates, BadDeviceToken). Without it every
            // failure looks the same in the log and an operator has nothing to
            // act on.
            reason: await res.text().then((t) => t.slice(0, 200)).catch(() => ''),
        });
        return 'failed';
    } catch (err) {
        logger.warn('apns.send_threw', {
            component: 'apns',
            subscriptionId: row.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'failed';
    }
}

/**
 * Remove every row holding a token APNs said is gone.
 *
 * KEYED ON THE TOKEN, not on (tenant, token), and that is a measurement rather
 * than a preference. Production holds two rows for one device: the same token
 * registered once per farm — 2 tenants, 1 user, 1 token, measured 2026-10-20.
 * So a 410 kills every row carrying that token, and a tenant-scoped delete
 * would remove one and leave the other to be sent to until it earned its own
 * 410.
 *
 * It runs under `runInTenantContext`, so RLS still bounds it to the caller's
 * tenant — the widening is across that tenant's rows for the token, not across
 * tenants. The other farm's row is removed when a send for that farm gets its
 * own 410, which is the next notification rather than never.
 */
async function pruneDeadTokens(ctx: RequestContext, tokens: string[]): Promise<void> {
    try {
        const removed = await runInTenantContext(ctx, (db) =>
            db.pushSubscription.deleteMany({
                where: { platform: 'IOS', deviceToken: { in: [...new Set(tokens)] } },
            }),
        );
        logger.info('apns.pruned_dead_tokens', {
            component: 'apns',
            // The COUNT, because a delete under RLS removes zero rows silently
            // when SELECT hides them — so "it ran" and "it deleted" are
            // different facts and only one of them is useful.
            tokens: new Set(tokens).size,
            rowsRemoved: removed.count,
        });
    } catch (err) {
        logger.warn('apns.prune_failed', {
            component: 'apns',
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

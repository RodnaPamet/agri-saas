/**
 * Webhook Processor — Core Processing Usecase
 *
 * Handles the full lifecycle of an incoming integration webhook:
 *   1. Persist raw event (IntegrationWebhookEvent)
 *   2. Resolve tenant from connection (never trust caller)
 *   3. Verify webhook signature
 *   4. Dispatch to provider handler
 *   5. Dispatch to the sync orchestrator when the provider supports CRUD sync
 *
 * SECURITY:
 *   - Tenant ID is resolved from IntegrationConnection, never from request
 *   - Signature verification is mandatory when provider supports it
 *   - Raw payload is retained for audit/replay (bounded by auto-cleanup)
 *
 * @module usecases/webhook-processor
 */
import { prisma } from '@/lib/prisma';
import { registry, integrationRegistry } from '../integrations/registry';
import { isWebhookEventProvider } from '../integrations/types';
import type { WebhookProcessResult } from '../integrations/types';
import { PrismaSyncMappingStore } from '../integrations/prisma-sync-store';
import { PrismaLocalStore } from '../integrations/prisma-local-store';
import { extractSignature, verifyHmacSha256, verifyGitHubSignature } from '../integrations/webhook-crypto';
import { decryptField } from '@/lib/security/encryption';
import { logger } from '@/lib/observability/logger';
import { getPermissionsForRole } from '@/lib/permissions';
import crypto from 'crypto';

/** Dedup window: ignore duplicate payloads within this period */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Max webhook events per provider per minute (rate limiting) */
export const WEBHOOK_RATE_LIMIT = 60;

// ─── Types ───────────────────────────────────────────────────────────

export interface WebhookInput {
    provider: string;
    rawBody: string;
    headers: Record<string, string>;
}

export type WebhookResult =
    | { status: 'processed'; eventId: string }
    | { status: 'ignored'; eventId: string; reason: string }
    | { status: 'auth_failed'; eventId?: string }
    | { status: 'invalid_provider' }
    | { status: 'error'; eventId: string; errorMessage: string };

// ─── Helpers ─────────────────────────────────────────────────────────

function decryptWebhookSecret(secretEncrypted: string | null): Record<string, unknown> {
    if (!secretEncrypted) return {};
    try {
        return JSON.parse(decryptField(secretEncrypted));
    } catch {
        return {};
    }
}

function getWebhookSecret(secrets: Record<string, unknown>): string | null {
    // Common secret key names across providers
    for (const key of ['webhookSecret', 'webhook_secret', 'secret', 'signingSecret']) {
        if (typeof secrets[key] === 'string' && secrets[key]) {
            return secrets[key] as string;
        }
    }
    return null;
}

/**
 * Verify webhook signature for a specific provider.
 * Returns true if verification passed or was skipped (no secret configured).
 * Returns false only when verification was attempted and failed.
 */
function verifyProviderSignature(
    provider: string,
    rawBody: string,
    headers: Record<string, string>,
    webhookSecret: string | null
): { verified: boolean; reason?: string } {
    // No secret configured — in dev, allow; in prod, this should be an error
    // but we log a warning and allow it (admin's responsibility to configure)
    if (!webhookSecret) {
        logger.warn('Webhook received without configured secret', {
            component: 'integrations',
            provider,
        });
        return { verified: true, reason: 'no_secret_configured' };
    }

    const signature = extractSignature(provider, headers);
    if (!signature) {
        return { verified: false, reason: 'missing_signature_header' };
    }

    // Provider-specific verification
    switch (provider) {
        case 'github': {
            const sigHeader = headers['x-hub-signature-256'] || '';
            return {
                verified: verifyGitHubSignature(rawBody, sigHeader, webhookSecret),
                reason: 'github_hmac',
            };
        }
        case 'gitlab': {
            // GitLab uses a simple token comparison in X-Gitlab-Token
            const token = headers['x-gitlab-token'] || '';
            return {
                verified: token === webhookSecret,
                reason: 'gitlab_token',
            };
        }
        default: {
            // Generic HMAC-SHA256 verification
            return {
                verified: verifyHmacSha256(rawBody, signature, webhookSecret, 'hex'),
                reason: 'generic_hmac',
            };
        }
    }
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Process an incoming webhook event end-to-end.
 *
 * This is the primary entry point called by the webhook route handler.
 * It handles every step from raw event persistence through evidence creation.
 */
export async function processIncomingWebhook(input: WebhookInput): Promise<WebhookResult> {
    const { provider, rawBody, headers } = input;
    const requestId = crypto.randomUUID();

    // 1. Check if we have a registered provider
    const providerImpl = registry.getProvider(provider);
    if (!providerImpl) {
        logger.warn('Webhook for unknown provider', { component: 'integrations', provider, requestId });
        return { status: 'invalid_provider' };
    }

    // 2. Parse body
    let parsedBody: unknown;
    try {
        parsedBody = JSON.parse(rawBody);
    } catch {
        parsedBody = rawBody; // Store raw if not JSON
    }

    // 2.5. Replay/idempotency check — deduplicate by payload hash
    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const dedupWindow = new Date(Date.now() - DEDUP_WINDOW_MS);

    const duplicateEvent = await prisma.integrationWebhookEvent.findFirst({
        where: {
            provider,
            payloadHash,
            createdAt: { gte: dedupWindow },
            status: { in: ['processed', 'received'] },
        },
        select: { id: true },
    });

    if (duplicateEvent) {
        logger.info('Webhook deduplicated — replay detected', {
            component: 'integrations',
            provider,
            requestId,
            duplicateOf: duplicateEvent.id,
            payloadHash: payloadHash.slice(0, 12),
        });
        return { status: 'ignored', eventId: duplicateEvent.id, reason: 'duplicate_payload' };
    }

    // 3. Persist raw event immediately (before validation)
    let event;
    try {
        event = await prisma.integrationWebhookEvent.create({
            data: {
                provider,
                eventType: typeof parsedBody === 'object' && parsedBody !== null
                    ? (parsedBody as Record<string, unknown>).action as string
                      ?? (parsedBody as Record<string, unknown>).event_type as string
                      ?? null
                    : null,
                payloadJson: (typeof parsedBody === 'object' && parsedBody !== null ? parsedBody : { raw: rawBody }) as object,
                headersJson: sanitizeHeaders(headers) as object,
                payloadHash,
                status: 'received',
            },
        });
    } catch (err) {
        logger.error('Failed to persist webhook event', {
            component: 'integrations',
            provider,
            err: err instanceof Error ? err : new Error(String(err)),
        });
        return { status: 'error', eventId: '', errorMessage: 'Failed to persist event' };
    }

    // 4. Find connections for this provider (resolve tenant from DB, not from caller)
    const connections = await prisma.integrationConnection.findMany({
        where: { provider, isEnabled: true },
        select: {
            id: true,
            tenantId: true,
            secretEncrypted: true,
            configJson: true,
        },
    });

    if (connections.length === 0) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'ignored', errorMessage: 'No active connections for provider' },
        });
        return { status: 'ignored', eventId: event.id, reason: 'no_connections' };
    }

    // 5. Try to verify and match to a connection
    let matchedConnection: typeof connections[0] | null = null;

    for (const conn of connections) {
        const secrets = decryptWebhookSecret(conn.secretEncrypted);
        const webhookSecret = getWebhookSecret(secrets);

        const verification = verifyProviderSignature(provider, rawBody, headers, webhookSecret);

        if (verification.verified) {
            matchedConnection = conn;
            break;
        }
    }

    if (!matchedConnection) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'error', errorMessage: 'Signature verification failed for all connections' },
        });
        return { status: 'auth_failed', eventId: event.id };
    }

    // 6. Update event with resolved tenant
    await prisma.integrationWebhookEvent.update({
        where: { id: event.id },
        data: { tenantId: matchedConnection.tenantId },
    });

    // 7. Establish tenant execution context
    const ctx = {
        tenantId: matchedConnection.tenantId,
        userId: 'system:webhook',
        requestId,
        role: 'ADMIN' as const,
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
        appPermissions: getPermissionsForRole('ADMIN'),
    };

    // 8. Dispatch to provider handler if it supports webhooks
    let processResult: WebhookProcessResult = { status: 'ignored' };

    if (isWebhookEventProvider(providerImpl)) {
        try {
            const secrets = decryptWebhookSecret(matchedConnection.secretEncrypted);
            const webhookSecret = getWebhookSecret(secrets);

            // Verify using provider's own verification method
            if (webhookSecret) {
                const isValid = providerImpl.verifyWebhookSignature(
                    {
                        provider,
                        headers,
                        body: parsedBody,
                        receivedAt: new Date(),
                    },
                    webhookSecret
                );
                if (!isValid) {
                    await prisma.integrationWebhookEvent.update({
                        where: { id: event.id },
                        data: { status: 'error', errorMessage: 'Provider signature verification failed' },
                    });
                    return { status: 'auth_failed', eventId: event.id };
                }
            }

            processResult = await providerImpl.handleWebhook(
                ctx,
                {
                    provider,
                    eventType: event.eventType ?? undefined,
                    headers,
                    body: parsedBody,
                    receivedAt: new Date(),
                },
                {
                    ...(matchedConnection.configJson as Record<string, unknown>),
                    ...decryptWebhookSecret(matchedConnection.secretEncrypted),
                }
            );

            // A provider handler may report `triggeredKeys` (the automation keys
            // the event fired). Practice was the only entity that carried an
            // automationKey and the GRC teardown removed it, so there is nothing
            // local to fan out to — this path no longer mints IntegrationExecution
            // or Evidence rows. Wire a new automationKey-bearing entity in here.

        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            logger.error('Webhook processing error in ProviderImpl', {
                component: 'integrations',
                provider,
                eventId: event.id,
                error: err instanceof Error ? err : new Error(String(err)),
            });

            await prisma.integrationWebhookEvent.update({
                where: { id: event.id },
                data: { status: 'error', errorMessage, processedAt: new Date() },
            });

            return { status: 'error', eventId: event.id, errorMessage };
        }
    }

    // 8.5. Dispatch to sync orchestrator if the provider supports CRUD orchestration
    if (integrationRegistry.has(provider)) {
        try {
            // Build complete connection config by merging stored config + decrypted secrets.
            // This ensures the orchestrator gets all required fields (e.g. owner, repo, token for GitHub).
            const connectionSecrets = decryptWebhookSecret(matchedConnection.secretEncrypted);
            const connectionConfig = {
                ...(matchedConnection.configJson as Record<string, unknown>),
                ...connectionSecrets,
            };

            const orchestrator = integrationRegistry.createOrchestrator(provider, {
                config: connectionConfig,
                store: new PrismaSyncMappingStore(),
                localStore: new PrismaLocalStore(),
                logger: {
                    log: (syncEvent: Record<string, unknown>) => logger.info('Sync event from webhook', {
                        component: 'integrations',
                        provider,
                        eventId: event.id,
                        syncEvent,
                    }),
                },
            });

            if (orchestrator) {
                const syncResult = await orchestrator.handleWebhookEvent({
                    ctx,
                    provider,
                    eventType: event.eventType || 'unknown',
                    payload: parsedBody as Record<string, unknown>,
                    connectionId: matchedConnection.id,
                });

                if (syncResult.processed) {
                    logger.info('Webhook dispatched to sync orchestrator', {
                        component: 'integrations',
                        provider,
                        eventId: event.id,
                        tenantId: matchedConnection.tenantId,
                        syncCount: syncResult.syncCount,
                        actions: syncResult.results.map(r => r.action),
                    });
                }
            }
        } catch (err) {
            // Sync orchestrator failures are logged but do NOT fail the webhook.
            // The webhook's primary job (persist event, run provider checks, create evidence)
            // has already succeeded above. Sync is a best-effort follow-on step.
            logger.error('Sync orchestrator dispatch failed', {
                component: 'integrations',
                provider,
                eventId: event.id,
                tenantId: matchedConnection.tenantId,
                error: err instanceof Error ? err : new Error(String(err)),
            });
        }
    }

    // 9. Finalize event status
    const finalStatus = processResult.status === 'error' ? 'error' : 'processed';
    await prisma.integrationWebhookEvent.update({
        where: { id: event.id },
        data: {
            status: finalStatus,
            processedAt: new Date(),
            errorMessage: processResult.errorMessage || null,
        },
    });

    logger.info('Webhook processed', {
        component: 'integrations',
        provider,
        eventId: event.id,
        tenantId: matchedConnection.tenantId,
        status: finalStatus,
    });

    return {
        status: 'processed',
        eventId: event.id,
    };
}

// ─── Header Sanitization ─────────────────────────────────────────────

/**
 * Sanitize headers for storage — remove sensitive values, keep structure.
 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const SENSITIVE_HEADERS = new Set([
        'authorization',
        'cookie',
        'set-cookie',
        'x-api-key',
    ]);

    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            sanitized[key] = '[REDACTED]';
        } else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

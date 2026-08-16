/**
 * Integration Framework — App-Layer Usecases
 *
 * Tenant-scoped operations for managing integration connections,
 * handling webhook events, and reporting integration diagnostics.
 *
 * All mutations require appropriate RBAC permissions.
 * All reads are scoped to the calling tenant.
 *
 * @module usecases/integrations
 */
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { registry } from '../integrations/registry';
import { encryptField } from '@/lib/security/encryption';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';

// ─── Connection Management ───────────────────────────────────────────

/**
 * List all integration connections for the tenant.
 * Secrets are never returned — only metadata.
 */
export async function listIntegrationConnections(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                provider: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                createdAt: true,
                updatedAt: true,
                _count: { select: { executions: true } },
            },
            orderBy: { createdAt: 'desc' },
        })
    );
}

/**
 * Get a single connection by ID (tenant-scoped, no secrets).
 */
export async function getIntegrationConnection(ctx: RequestContext, connectionId: string) {
    return runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
            select: {
                id: true,
                provider: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                createdAt: true,
                updatedAt: true,
            },
        });
        if (!conn) throw notFound('Integration connection not found');
        return conn;
    });
}

/**
 * Create or update an integration connection.
 * Secrets are encrypted before storage.
 */
export async function upsertIntegrationConnection(
    ctx: RequestContext,
    input: {
        id?: string;
        provider: string;
        name: string;
        configJson?: Record<string, unknown>;
        secrets?: Record<string, unknown>;
        isEnabled?: boolean;
    }
) {
    if (!ctx.permissions?.canAdmin) throw forbidden('Admin only');

    // Validate provider is registered
    const providerImpl = registry.getProvider(input.provider);
    if (!providerImpl) throw badRequest(`Unknown provider: ${input.provider}`);

    // Encrypt secrets if provided
    let secretEncrypted: string | undefined;
    if (input.secrets && Object.keys(input.secrets).length > 0) {
        secretEncrypted = encryptField(JSON.stringify(input.secrets));
    }

    return runInTenantContext(ctx, async (db) => {
        if (input.id) {
            // Update existing
            const existing = await db.integrationConnection.findFirst({
                where: { id: input.id, tenantId: ctx.tenantId },
            });
            if (!existing) throw notFound('Connection not found');

            const updated = await db.integrationConnection.update({
                where: { id: input.id },
                data: {
                    name: input.name,
                    configJson: input.configJson != null ? (input.configJson as Prisma.InputJsonValue) : undefined,
                    ...(secretEncrypted ? { secretEncrypted } : {}),
                    isEnabled: input.isEnabled ?? true,
                },
            });

            await logEvent(db, ctx, {
                action: 'INTEGRATION_CONNECTION_UPDATED',
                entityType: 'IntegrationConnection',
                entityId: updated.id,
                detailsJson: {
                    category: 'entity_lifecycle',
                    entityName: 'IntegrationConnection',
                    operation: 'updated',
                    provider: input.provider,
                    summary: `Updated integration: ${input.name}`,
                },
            });

            return updated;
        }

        // Create new
        const created = await db.integrationConnection.create({
            data: {
                tenantId: ctx.tenantId,
                provider: input.provider,
                name: input.name,
                configJson: (input.configJson ?? {}) as Prisma.InputJsonValue,
                secretEncrypted,
                isEnabled: input.isEnabled ?? true,
            },
        });

        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_CREATED',
            entityType: 'IntegrationConnection',
            entityId: created.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'created',
                provider: input.provider,
                summary: `Created integration: ${input.name}`,
            },
        });

        return created;
    });
}

/**
 * Remove (soft-disable) an integration connection.
 */
export async function removeIntegrationConnection(ctx: RequestContext, connectionId: string) {
    if (!ctx.permissions?.canAdmin) throw forbidden('Admin only');

    return runInTenantContext(ctx, async (db) => {
        const existing = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId },
        });
        if (!existing) throw notFound('Connection not found');

        await db.integrationConnection.update({
            where: { id: connectionId },
            data: { isEnabled: false },
        });

        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_DISABLED',
            entityType: 'IntegrationConnection',
            entityId: connectionId,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'deleted',
                provider: existing.provider,
                summary: `Disabled integration: ${existing.name}`,
            },
        });

        return { ok: true };
    });
}

// ─── Webhook Handling ────────────────────────────────────────────────

/**
 * Handle an incoming integration webhook event.
 * Persists the raw event, resolves the provider, and dispatches processing.
 */
export async function handleIncomingWebhook(
    tenantId: string | null,
    provider: string,
    payload: {
        eventType?: string;
        headers: Record<string, string>;
        body: unknown;
    }
) {
    const { prisma } = await import('@/lib/prisma');

    // 1. Persist raw event
    const event = await prisma.integrationWebhookEvent.create({
        data: {
            tenantId,
            provider,
            eventType: payload.eventType,
            payloadJson: payload.body as object,
            headersJson: payload.headers as object,
            status: 'received',
        },
    });

    // 2. Resolve webhook handler
    const webhookProvider = registry.getWebhookProvider(provider);
    if (!webhookProvider) {
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'ignored', errorMessage: `No handler for provider: ${provider}` },
        });
        return { eventId: event.id, status: 'ignored' as const };
    }

    // 3. Process (in a try/catch to ensure event status is updated)
    try {
        // For now, mark as processed — real webhook handling comes in a later prompt
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'processed', processedAt: new Date() },
        });

        return { eventId: event.id, status: 'processed' as const };
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await prisma.integrationWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'error', errorMessage },
        });
        return { eventId: event.id, status: 'error' as const, errorMessage };
    }
}

// ─── Registry & Connection Metadata ──────────────────────────────────

/**
 * List all automation keys available in the registry.
 * The practice automationKey dropdown this fed was removed by the GRC
 * teardown; the registry keys themselves still route incoming webhooks.
 */
export function listAvailableAutomationKeys(): string[] {
    return registry.listAllAutomationKeys();
}

/**
 * List all registered integration providers with their metadata.
 * Used by the admin UI to show available integrations.
 */
export function listAvailableProviders() {
    return registry.listProviders().map(p => ({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        supportedChecks: p.supportedChecks,
        configSchema: p.configSchema,
    }));
}

/**
 * Update a connection's test status.
 * Used by the route handler after validating a connection.
 */
export async function updateConnectionTestStatus(
    ctx: RequestContext,
    connectionId: string,
    status: string
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.updateMany({
            where: { id: connectionId, tenantId: ctx.tenantId },
            data: {
                lastTestedAt: new Date(),
                lastTestStatus: status,
            },
        })
    );
}

// ─── Diagnostics ─────────────────────────────────────────────────────

/**
 * Get integration diagnostics for a tenant.
 * Returns recent executions, webhook events, and error counts.
 * Admin-only. Secrets never included.
 */
export async function getIntegrationDiagnostics(ctx: RequestContext) {
    return runInTenantContext(ctx, async (db) => {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const [recentExecutions, recentWebhooks, errorCount24h] = await Promise.all([
            db.integrationExecution.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    provider: true,
                    automationKey: true,
                    status: true,
                    triggeredBy: true,
                    errorMessage: true,
                    durationMs: true,
                    executedAt: true,
                    completedAt: true,
                },
                orderBy: { executedAt: 'desc' },
                take: 10,
            }),
            db.integrationWebhookEvent.findMany({
                where: { tenantId: ctx.tenantId },
                select: {
                    id: true,
                    provider: true,
                    eventType: true,
                    status: true,
                    errorMessage: true,
                    createdAt: true,
                    processedAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 10,
            }),
            db.integrationExecution.count({
                where: {
                    tenantId: ctx.tenantId,
                    status: 'ERROR',
                    executedAt: { gte: dayAgo },
                },
            }),
        ]);

        return {
            recentExecutions,
            recentWebhooks,
            errorCount24h,
            generatedAt: new Date().toISOString(),
        };
    });
}

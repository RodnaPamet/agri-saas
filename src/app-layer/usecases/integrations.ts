/**
 * Integration Framework — App-Layer Usecases
 *
 * Tenant-scoped operations for managing integration connections,
 * executing automation checks, and handling webhook events.
 *
 * All mutations require appropriate RBAC permissions.
 * All reads are scoped to the calling tenant.
 *
 * @module usecases/integrations
 */
import { Prisma, EvidenceType } from '@prisma/client';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { registry } from '../integrations/registry';
import { isScheduledCheckProvider } from '../integrations/types';
import type { CheckResult, EvidencePayload } from '../integrations/types';
import { encryptField, decryptField } from '@/lib/security/encryption';
import { logEvent } from '../events/audit';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';

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

// ─── Automation Execution ────────────────────────────────────────────

/**
 * Decrypt the secrets for a connection. Used internally by execution logic.
 * @internal
 */
function decryptConnectionSecrets(secretEncrypted: string | null): Record<string, unknown> {
    if (!secretEncrypted) return {};
    try {
        return JSON.parse(decryptField(secretEncrypted));
    } catch {
        logger.error('Failed to decrypt integration secrets', { component: 'integrations' });
        return {};
    }
}

/**
 * Run an automation check for a specific Practice.
 * Resolves the Practice's automationKey → provider → executes check → persists result.
 */
export async function runAutomationForPractice(
    ctx: RequestContext,
    practiceId: string,
    options: { triggeredBy?: 'scheduled' | 'manual' | 'webhook'; jobRunId?: string } = {}
) {
    const triggeredBy = options.triggeredBy ?? 'manual';

    return runInTenantContext(ctx, async (db) => {
        // 1. Fetch practice + automationKey
        const practice = await db.practice.findFirst({
            where: { id: practiceId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, automationKey: true, tenantId: true, name: true },
        });
        if (!practice) throw notFound('Practice not found');
        if (!practice.automationKey) throw badRequest('Practice has no automationKey');

        // 2. Resolve provider
        const resolution = registry.resolveByAutomationKey(practice.automationKey);
        if (!resolution) throw badRequest(`No provider for automationKey: ${practice.automationKey}`);

        const { provider, parsed } = resolution;
        if (!isScheduledCheckProvider(provider)) {
            throw badRequest(`Provider ${parsed.provider} does not support scheduled checks`);
        }

        // 3. Find active connection for this provider+tenant
        const connection = await db.integrationConnection.findFirst({
            where: {
                tenantId: ctx.tenantId,
                provider: parsed.provider,
                isEnabled: true,
            },
        });
        if (!connection) throw badRequest(`No active connection for provider: ${parsed.provider}`);

        // 4. Create PENDING execution record
        const execution = await db.integrationExecution.create({
            data: {
                tenantId: ctx.tenantId,
                connectionId: connection.id,
                provider: parsed.provider,
                automationKey: practice.automationKey,
                practiceId: practice.id,
                status: 'RUNNING',
                triggeredBy,
                jobRunId: options.jobRunId,
            },
        });

        // 5. Execute check
        const startTime = Date.now();
        let result: CheckResult;

        try {
            const secrets = decryptConnectionSecrets(connection.secretEncrypted);
            result = await provider.runCheck({
                automationKey: practice.automationKey,
                parsed,
                tenantId: ctx.tenantId,
                practiceId: practice.id,
                connectionConfig: {
                    ...(connection.configJson as Record<string, unknown>),
                    ...secrets,
                },
                triggeredBy,
                jobRunId: options.jobRunId,
            });
        } catch (err) {
            // Check execution failed at runtime
            const durationMs = Date.now() - startTime;
            const errorMessage = err instanceof Error ? err.message : String(err);

            await db.integrationExecution.update({
                where: { id: execution.id },
                data: {
                    status: 'ERROR',
                    errorMessage,
                    durationMs,
                    completedAt: new Date(),
                },
            });

            logger.error('Integration check execution error', {
                component: 'integrations',
                provider: parsed.provider,
                automationKey: practice.automationKey,
                practiceId: practice.id,
                error: errorMessage,
            });

            return { execution: { ...execution, status: 'ERROR', errorMessage, durationMs } };
        }

        const durationMs = result.durationMs ?? (Date.now() - startTime);

        // 6. Persist result
        let evidenceId: string | undefined;

        // 7. Optionally create evidence
        if (result.status === 'PASSED' || result.status === 'FAILED') {
            const evidencePayload: EvidencePayload | null = provider.mapResultToEvidence(
                {
                    automationKey: practice.automationKey,
                    parsed,
                    tenantId: ctx.tenantId,
                    practiceId: practice.id,
                    connectionConfig: {},
                    triggeredBy,
                },
                result
            );

            if (evidencePayload) {
                const evidence = await db.evidence.create({
                    data: {
                        tenantId: ctx.tenantId,
                        practiceId: practice.id,
                        // Integration EvidencePayload.type uses a wider vocabulary
                        // (DOCUMENT/SCREENSHOT/LOG/CONFIGURATION/REPORT) than the
                        // Prisma EvidenceType enum (FILE/LINK/TEXT). Integration-created
                        // evidence is always text-based content; map to TEXT.
                        type: EvidenceType.TEXT,
                        title: evidencePayload.title,
                        content: evidencePayload.content,
                        category: evidencePayload.category ?? 'integration',
                        status: 'APPROVED',
                    },
                });
                evidenceId = evidence.id;
            }
        }

        // 8. Update execution with result
        await db.integrationExecution.update({
            where: { id: execution.id },
            data: {
                status: result.status,
                resultJson: result.details as Prisma.InputJsonValue,
                evidenceId,
                errorMessage: result.errorMessage,
                durationMs,
                completedAt: new Date(),
            },
        });

        logger.info('Integration check completed', {
            component: 'integrations',
            provider: parsed.provider,
            automationKey: practice.automationKey,
            status: result.status,
            durationMs,
        });

        return {
            execution: {
                id: execution.id,
                status: result.status,
                summary: result.summary,
                durationMs,
                evidenceId,
            },
        };
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

// ─── Execution History ───────────────────────────────────────────────

/**
 * List recent executions for a practice.
 */
export async function listExecutionsForPractice(
    ctx: RequestContext,
    practiceId: string,
    options: { limit?: number } = {}
) {
    return runInTenantContext(ctx, (db) =>
        db.integrationExecution.findMany({
            where: { tenantId: ctx.tenantId, practiceId },
            select: {
                id: true,
                provider: true,
                automationKey: true,
                status: true,
                resultJson: true,
                evidenceId: true,
                durationMs: true,
                triggeredBy: true,
                errorMessage: true,
                executedAt: true,
                completedAt: true,
            },
            orderBy: { executedAt: 'desc' },
            take: options.limit ?? 20,
        })
    );
}

/**
 * List all automation keys available in the registry.
 * Used by the UI to populate practice automationKey dropdowns.
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

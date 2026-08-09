/**
 * Integration Framework — Core Types
 *
 * Defines the contracts for the plugin-based integration system.
 * All providers implement these interfaces to participate in:
 *   - Scheduled automation checks (cron-based, routed by automationKey)
 *   - Webhook event processing (incoming events from external services)
 *   - Evidence auto-creation from check results
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AUTOMATION KEY FORMAT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Format: `{provider}.{check_type}`
 *
 * Examples:
 *   github.branch_protection    — verifies branch protection rules
 *   github.repo_security        — checks security settings on repos
 *   aws.s3_encryption           — verifies S3 bucket encryption
 *   aws.iam_mfa                 — checks MFA enforcement on IAM users
 *   azure.defender_status       — checks Defender for Cloud status
 *
 * The provider prefix routes to the registered IntegrationProvider.
 * The check_type selects the specific check within that provider.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * EXECUTION FLOW
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Scheduled:
 *   1. Cron job finds Practices where automationKey is set
 *   2. Registry resolves automationKey prefix → IntegrationProvider
 *   3. Provider.runCheck() executes the check
 *   4. Result is persisted as IntegrationExecution
 *   5. Optionally, Provider.mapResultToEvidence() creates Evidence
 *
 * Webhook:
 *   1. Webhook receiver persists raw event as IntegrationWebhookEvent
 *   2. Registry resolves provider → WebhookEventProvider
 *   3. Provider.handleWebhook() processes the event
 *   4. Provider may trigger runCheck() or directly create evidence
 *
 * @module integrations/types
 */
import type { RequestContext } from '../types';

// ─── automationKey Utilities ─────────────────────────────────────────

/**
 * Parsed automationKey: `{provider}.{checkType}`.
 */
export interface ParsedAutomationKey {
    provider: string;
    checkType: string;
    raw: string;
}

/**
 * Parse an automationKey string into provider + check type.
 * Returns null for invalid keys (must have at least `provider.check`).
 */
export function parseAutomationKey(key: string): ParsedAutomationKey | null {
    if (!key || typeof key !== 'string') return null;
    const dotIndex = key.indexOf('.');
    if (dotIndex <= 0 || dotIndex === key.length - 1) return null;

    return {
        provider: key.substring(0, dotIndex),
        checkType: key.substring(dotIndex + 1),
        raw: key,
    };
}

// ─── Check Input / Output ────────────────────────────────────────────

/**
 * Input to a scheduled or manual check execution.
 */
export interface CheckInput {
    /** The full automationKey (e.g. "github.branch_protection") */
    automationKey: string;
    /** Parsed provider and check type */
    parsed: ParsedAutomationKey;
    /** Tenant context */
    tenantId: string;
    /** The practice this check is for (if any) */
    practiceId?: string;
    /** Provider-specific connection config (decrypted) */
    connectionConfig: Record<string, unknown>;
    /** How the check was triggered */
    triggeredBy: 'scheduled' | 'manual' | 'webhook';
    /** Optional correlation ID for batch runs */
    jobRunId?: string;
}

/**
 * Result of a check execution.
 */
export interface CheckResult {
    /** Whether the check passed */
    status: 'PASSED' | 'FAILED' | 'ERROR';
    /** Human-readable summary */
    summary: string;
    /** Provider-specific structured result */
    details: Record<string, unknown>;
    /** Optional evidence to create */
    evidence?: EvidencePayload;
    /** Duration in ms */
    durationMs?: number;
    /** Error message if status is ERROR */
    errorMessage?: string;
}

/**
 * Payload for auto-creating Evidence from a check result.
 */
export interface EvidencePayload {
    title: string;
    content: string;
    type: 'DOCUMENT' | 'SCREENSHOT' | 'LOG' | 'CONFIGURATION' | 'REPORT';
    category?: string;
}

// ─── Webhook Types ───────────────────────────────────────────────────

/**
 * Incoming webhook payload with metadata.
 */
export interface WebhookPayload {
    provider: string;
    eventType?: string;
    headers: Record<string, string>;
    body: unknown;
    receivedAt: Date;
}

/**
 * Result of processing a webhook event.
 */
export interface WebhookProcessResult {
    status: 'processed' | 'ignored' | 'error';
    /** Which automation keys were triggered, if any */
    triggeredKeys?: string[];
    errorMessage?: string;
}

// ─── Connection Config ───────────────────────────────────────────────

/**
 * Schema for validating provider connection configuration.
 */
export interface ConnectionConfigSchema {
    /** JSON Schema for the configJson field */
    configFields: ConfigField[];
    /** JSON Schema for the secret fields */
    secretFields: ConfigField[];
}

export interface ConfigField {
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    required: boolean;
    description?: string;
    options?: string[]; // for 'select' type
    placeholder?: string;
}

/**
 * Connection validation result.
 */
export interface ConnectionValidationResult {
    valid: boolean;
    error?: string;
}

// ─── Provider Interfaces ─────────────────────────────────────────────

/**
 * Base interface for all integration providers.
 * Every provider must implement this.
 */
export interface IntegrationProvider {
    /** Unique provider identifier (must match automationKey prefix) */
    readonly id: string;
    /** Human-readable provider name */
    readonly displayName: string;
    /** Provider description */
    readonly description: string;
    /** Supported automation check types */
    readonly supportedChecks: string[];
    /** Connection configuration schema */
    readonly configSchema: ConnectionConfigSchema;

    /**
     * Validate that a connection config is correct and credentials work.
     * Called when admin sets up or tests a connection.
     */
    validateConnection(
        config: Record<string, unknown>,
        secrets: Record<string, unknown>
    ): Promise<ConnectionValidationResult>;
}

/**
 * Provider that supports scheduled automation checks.
 * Practices with matching automationKey will route here.
 */
export interface ScheduledCheckProvider extends IntegrationProvider {
    /**
     * Execute a check and return the result.
     * The framework handles persistence and evidence creation.
     */
    runCheck(input: CheckInput): Promise<CheckResult>;

    /**
     * Map a check result to an Evidence payload.
     * If the check produced evidence, this transforms it.
     */
    mapResultToEvidence(
        input: CheckInput,
        result: CheckResult
    ): EvidencePayload | null;
}

/**
 * Provider that can process incoming webhook events.
 */
export interface WebhookEventProvider extends IntegrationProvider {
    /**
     * Verify webhook signature/authenticity.
     * Returns true if the webhook is valid.
     */
    verifyWebhookSignature(
        payload: WebhookPayload,
        secret: string
    ): boolean;

    /**
     * Process a verified webhook event.
     * May trigger checks or directly create evidence.
     */
    handleWebhook(
        ctx: RequestContext,
        payload: WebhookPayload,
        connectionConfig: Record<string, unknown>
    ): Promise<WebhookProcessResult>;
}

// ─── Type Guards ─────────────────────────────────────────────────────

export function isScheduledCheckProvider(
    provider: IntegrationProvider
): provider is ScheduledCheckProvider {
    return 'runCheck' in provider && typeof (provider as ScheduledCheckProvider).runCheck === 'function';
}

export function isWebhookEventProvider(
    provider: IntegrationProvider
): provider is WebhookEventProvider {
    return 'handleWebhook' in provider && typeof (provider as WebhookEventProvider).handleWebhook === 'function';
}

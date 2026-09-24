/**
 * API Key Authentication — Machine-to-Machine Auth
 *
 * Provides:
 *   - Key generation (cryptographically random, prefixed for identification)
 *   - Hash-only storage (SHA-256, plaintext shown once at creation)
 *   - Bearer token verification against stored hash
 *   - Expiry and revocation enforcement
 *   - Last-used tracking (async, non-blocking)
 *   - Scope-based authorization (maps to PermissionSet resource:action)
 *   - RequestContext construction for downstream authorization
 *
 * Key format: "iflk_" + 48 random hex chars (total 53 chars)
 * Storage: SHA-256(full key) — deterministic, fast, collision-resistant
 *
 * Scope format: "resource:action" (e.g. "evidence:read", "tasks:write")
 * Special scopes:
 *   - "*" = full access (all resources, all actions)
 *   - "resource:*" = all actions on a resource
 *
 * SECURITY NOTES:
 *   - Plaintext key is returned ONLY at creation time, never stored.
 *   - SHA-256 is suitable for API key hashing (keys have high entropy,
 *     unlike passwords which need bcrypt/argon2).
 *   - Expired and revoked keys are rejected immediately.
 *   - lastUsedAt updates are fire-and-forget to avoid auth latency.
 *   - Scope enforcement is mandatory for API-key-authenticated requests.
 *
 * @module auth/api-key-auth
 */
import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import { forbidden, codedForbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import type { TenantApiKey, Tenant } from '@prisma/client';

// ─── Constants ───

/** Prefix for all API keys — enables quick visual identification */
// The format lives in a dependency-free module so the Edge can import it
// without pulling in Prisma. Imported AND re-exported: the re-export keeps
// existing importers working, the import is what makes the constant usable
// below (a bare `export ... from` re-exports without binding it locally).
import { API_KEY_PREFIX, isApiKeyToken } from './api-key-token';
import {
    API_KEY_SCOPE_FAMILIES,
    isScopableFamily,
    scopeActionForMethod,
    scopeResourceForPath,
    type ScopeAction,
} from './api-key-scope';
export { API_KEY_PREFIX, isApiKeyToken };

/** Length of random hex portion (48 hex = 24 bytes of entropy) */
const KEY_RANDOM_LENGTH = 48;

/** Number of prefix chars stored for key identification (e.g. "iflk_a1b2") */
const KEY_PREFIX_DISPLAY_LENGTH = 8;

// ─── Scope Definitions ───

/**
 * Mapping from scope action keywords to PermissionSet action names.
 *
 * Scopes use simplified verbs:
 *   - "read"  → maps to "view" (and "download", "export" where applicable)
 *   - "write" → maps to "create", "edit", "upload", "assign", etc.
 *   - "admin" → maps to "manage", "approve", "freeze", etc.
 *
 * This keeps the scope vocabulary small and M2M-friendly while mapping
 * to the full PermissionSet internally.
 */
const SCOPE_ACTION_MAP: Record<string, Record<string, string[]>> = {
    evidence:   { read: ['view', 'download'], write: ['upload', 'edit'] },
    tasks:      { read: ['view'], write: ['create', 'edit', 'assign'] },
    reports:    { read: ['view'], write: ['export'] },
    admin:      { read: ['view'], write: ['manage', 'members', 'sso', 'scim'] },
};

/**
 * All valid scope strings that can be assigned to an API key.
 */
export const VALID_SCOPES: string[] = [
    '*', // full access
    // One resource per tenant-API path family, so a scope names exactly the
    // surface it unlocks. This REPLACED a four-resource vocabulary derived
    // from SCOPE_ACTION_MAP; all four of those (evidence, tasks, reports,
    // admin) are path families themselves, so this is a strict superset and
    // every key ever issued keeps the meaning it was issued with.
    //
    // SCOPE_ACTION_MAP is still the map from a scope to a PermissionSet — it
    // answers a different question (what does this key's `appPermissions`
    // look like) and covers only the five domains a PermissionSet HAS.
    // Reaching a resource is gated by the family list; what a key may do once
    // there is gated by permissions as before.
    ...API_KEY_SCOPE_FAMILIES.flatMap((resource) => [
        `${resource}:*`,
        `${resource}:read`,
        `${resource}:write`,
    ]),
];

/**
 * Validates an array of scope strings.
 * Returns error messages for invalid scopes.
 */
export function validateScopes(scopes: unknown): string[] {
    if (!Array.isArray(scopes)) return ['Scopes must be an array'];
    if (scopes.length === 0) return ['At least one scope is required'];

    const errors: string[] = [];
    for (const scope of scopes) {
        if (typeof scope !== 'string') {
            errors.push(`Invalid scope type: ${typeof scope}`);
            continue;
        }
        if (!VALID_SCOPES.includes(scope)) {
            errors.push(`Invalid scope: "${scope}". Valid scopes: ${VALID_SCOPES.join(', ')}`);
        }
    }
    return errors;
}

/**
 * Convert an array of scope strings into a PermissionSet.
 * Used to build appPermissions for API-key-authenticated contexts.
 */
export function scopesToPermissions(scopes: string[]): PermissionSet {
    // Start with all-false
    const base = getPermissionsForRole('READER');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = {};
    for (const [resource, actions] of Object.entries(base)) {
        result[resource] = {};
        for (const action of Object.keys(actions as Record<string, boolean>)) {
            result[resource][action] = false;
        }
    }

    // Full access shortcut
    if (scopes.includes('*')) {
        return getPermissionsForRole('ADMIN');
    }

    for (const scope of scopes) {
        const [resource, action] = scope.split(':');

        if (!(resource in SCOPE_ACTION_MAP)) continue;

        if (action === '*') {
            // All actions on this resource
            for (const [, permActions] of Object.entries(SCOPE_ACTION_MAP[resource])) {
                for (const permAction of permActions) {
                    if (permAction in result[resource]) {
                        result[resource][permAction] = true;
                    }
                }
            }
        } else if (action in SCOPE_ACTION_MAP[resource]) {
            // Specific action group
            const permActions = SCOPE_ACTION_MAP[resource][action];
            for (const permAction of permActions) {
                if (permAction in result[resource]) {
                    result[resource][permAction] = true;
                }
            }
        }
    }

    return result as PermissionSet;
}

/**
 * Enforce API key scopes on a request context.
 *
 * Call this in any endpoint that may receive API-key-authenticated requests.
 * Checks whether the API key's scopes grant access to the requested
 * resource and action. Throws 403 if not.
 *
 * For session-authenticated requests (no apiKeyId), this is a no-op.
 *
 * @param ctx - Request context (may or may not be API-key-authenticated)
 * @param resource - The resource being accessed (e.g. "practices")
 * @param action - The action being performed ("read" | "write" | "admin")
 */
export function enforceApiKeyScope(
    ctx: RequestContext,
    resource: string,
    action: 'read' | 'write' | 'admin',
): void {
    // Not an API key request — skip scope enforcement (user auth handles permissions)
    if (!ctx.apiKeyId || !ctx.apiKeyScopes) return;

    const scopes = ctx.apiKeyScopes;

    // Full access
    if (scopes.includes('*')) return;

    // Resource wildcard
    if (scopes.includes(`${resource}:*`)) return;

    // Specific scope
    if (scopes.includes(`${resource}:${action}`)) return;

    throw forbidden(
        `API key does not have scope "${resource}:${action}". ` +
        `Granted scopes: ${scopes.join(', ')}`
    );
}

/**
 * Does this key hold `resource:action`? The boolean form of
 * {@link enforceApiKeyScope}, for callers that must combine several checks
 * before deciding (permission requirements come in `any`/`all` sets).
 *
 * Returns true for a session context, which holds no scopes: scope logic must
 * never be the thing that refuses a logged-in user.
 */
export function hasApiKeyScope(
    ctx: RequestContext,
    resource: string,
    action: ScopeAction,
): boolean {
    if (!ctx.apiKeyId || !ctx.apiKeyScopes) return true;
    const scopes = ctx.apiKeyScopes;
    return (
        scopes.includes('*') ||
        scopes.includes(`${resource}:*`) ||
        scopes.includes(`${resource}:${action}`)
    );
}

/**
 * The action a dotted permission key represents.
 *
 * `evidence.view` and `evidence.download` are reads; everything else is a
 * write. Unknown suffixes fall to WRITE so a new permission cannot be reached
 * by a read-only key by default.
 */
export function scopeActionForPermissionKey(key: string): ScopeAction {
    const suffix = key.split('.')[1] ?? '';
    return suffix === 'view' || suffix === 'download' ? 'read' : 'write';
}

/**
 * The per-REQUEST scope gate: may this API key reach this path at all?
 *
 * Called from `getTenantCtx`, which every tenant route reaches, so it covers
 * the ~250 routes that gate on `assertCanWrite` and never call
 * `requirePermission`. Without it a `tasks:write` key could write journal
 * entries, field operations and insurance leads, because the only thing the
 * coarse role derivation carries forward from a scope is "may write
 * something". See `api-key-scope.ts` for the full account.
 *
 * ── Why `*` does not bypass the family check ──
 *
 * `enforceApiKeyScope` returns early for a `*` key, which is right for an
 * action check and wrong for a REACHABILITY one. A path family absent from
 * `API_KEY_SCOPE_FAMILIES` is not a surface someone decided a key may not
 * reach — it is one nobody has reviewed for machine access yet, and several
 * existing families (`sso`, `security`, `billing`) are ones a reviewer might
 * well refuse. So the family check runs FIRST and binds every key, wildcard
 * included: `*` means "every resource I have been granted", not "every
 * resource that will ever exist".
 *
 * A session-authenticated context has no `apiKeyId` and is unaffected.
 */
export function assertApiKeyMayReachPath(
    ctx: RequestContext,
    pathname: string,
    method: string,
): void {
    if (!ctx.apiKeyId) return;

    const family = scopeResourceForPath(pathname);
    if (!family) {
        // An API key presented outside `/api/t/<slug>/...`. The Edge carve-out
        // is bounded to that prefix, so this is unreachable over HTTP today —
        // refusing rather than allowing keeps it that way if the bound moves.
        throw codedForbidden(
            'API_KEY_WRONG_SURFACE',
            'API keys may only be used on the tenant API.',
        );
    }

    if (!isScopableFamily(family)) {
        throw codedForbidden(
            'API_KEY_FAMILY_NOT_ENABLED',
            `API keys cannot be used for "${family}". That surface has not been ` +
            `enabled for key access.`,
            { resource: family },
        );
    }

    enforceApiKeyScope(ctx, family, scopeActionForMethod(method));
}

// ─── Key Generation ───

/**
 * Generate a new API key.
 *
 * @returns Object with `plaintext` (show once), `keyHash`, and `keyPrefix`
 */
export function generateApiKey(): {
    plaintext: string;
    keyHash: string;
    keyPrefix: string;
} {
    const randomPart = crypto.randomBytes(KEY_RANDOM_LENGTH / 2).toString('hex');
    const plaintext = `${API_KEY_PREFIX}${randomPart}`;
    const keyHash = hashApiKey(plaintext);
    const keyPrefix = plaintext.slice(0, API_KEY_PREFIX.length + KEY_PREFIX_DISPLAY_LENGTH);

    return { plaintext, keyHash, keyPrefix };
}

/**
 * Hash an API key for storage/lookup using SHA-256.
 *
 * SHA-256 is appropriate here because API keys have high entropy
 * (24 bytes = 192 bits), unlike user passwords.
 */
export function hashApiKey(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

// ─── Key Verification ───

export interface ApiKeyAuthResult {
    valid: true;
    apiKey: TenantApiKey & { tenant: Tenant };
    ctx: RequestContext;
}

export interface ApiKeyAuthError {
    valid: false;
    reason: 'not_found' | 'expired' | 'revoked' | 'invalid_format';
}

export type ApiKeyVerifyResult = ApiKeyAuthResult | ApiKeyAuthError;

/**
 * Verify a bearer token as an API key and build a RequestContext.
 *
 * @param bearerToken - The raw token from the Authorization header (without "Bearer " prefix)
 * @param clientIp - Optional IP for last-used tracking
 * @returns Verification result with RequestContext if valid
 */
export async function verifyApiKey(
    bearerToken: string,
    clientIp?: string | null,
): Promise<ApiKeyVerifyResult> {
    // Quick format check
    if (!bearerToken.startsWith(API_KEY_PREFIX)) {
        return { valid: false, reason: 'invalid_format' };
    }

    const keyHash = hashApiKey(bearerToken);

    // Look up by hash (unique index — fast)
    const apiKey = await prisma.tenantApiKey.findUnique({
        where: { keyHash },
        include: { tenant: true },
    });

    if (!apiKey) {
        return { valid: false, reason: 'not_found' };
    }

    // Check revocation
    if (apiKey.revokedAt) {
        return { valid: false, reason: 'revoked' };
    }

    // Check expiry
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return { valid: false, reason: 'expired' };
    }

    // Update lastUsedAt (fire-and-forget — don't block auth)
    updateLastUsed(apiKey.id, clientIp).catch(() => {
        // Swallow errors — tracking failure must not break auth
    });

    // Parse scopes from stored JSON
    const scopes = Array.isArray(apiKey.scopes) ? (apiKey.scopes as string[]) : [];

    // Build permissions from scopes instead of giving blanket ADMIN
    const appPermissions = scopesToPermissions(scopes);

    // Determine effective role from scopes
    const hasAdminScope = scopes.includes('*') || scopes.includes('admin:write');
    const hasWriteScope = scopes.some(s => s.endsWith(':write') || s.endsWith(':*') || s === '*');
    const role = hasAdminScope ? 'ADMIN' as const
        : hasWriteScope ? 'EDITOR' as const
        : 'READER' as const;

    const ctx: RequestContext = {
        requestId: crypto.randomUUID(),
        userId: apiKey.createdById,
        tenantId: apiKey.tenantId,
        tenantSlug: apiKey.tenant.slug,
        role,
        permissions: computePermissions(role),
        appPermissions,
        apiKeyId: apiKey.id,
        apiKeyScopes: scopes,
    };

    return { valid: true, apiKey, ctx };
}

/**
 * Extract a bearer token from an Authorization header value.
 *
 * @param authHeader - Full "Authorization" header value
 * @returns The token portion, or null if not a Bearer token
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
    if (!authHeader) return null;
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
    return parts[1];
}



// ─── Internal Helpers ───

async function updateLastUsed(apiKeyId: string, clientIp?: string | null): Promise<void> {
    await prisma.tenantApiKey.update({
        where: { id: apiKeyId },
        data: {
            lastUsedAt: new Date(),
            ...(clientIp ? { lastUsedIp: clientIp } : {}),
        },
    });
}

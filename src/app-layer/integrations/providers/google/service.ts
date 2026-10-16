/**
 * Google connection-management usecases — #2005.
 *
 * Owns the connection lifecycle on top of the generic `IntegrationConnection`
 * model: completing the consent flow and resolving an authed access token with
 * refresh-on-expiry. Admin-gated and tenant-scoped (RLS via
 * `runInTenantContext`), shaped after
 * `src/app-layer/integrations/providers/sharepoint/service.ts`.
 *
 * ## No registry entry, deliberately
 *
 * `src/app-layer/integrations/registry.ts` serves the generic
 * `POST /admin/integrations` path and the automation keys. The OAuth connect
 * flow creates its row directly, as SharePoint's does, and the list endpoint
 * adds masking and a webhook URL per connection without consulting the
 * registry — so a `google` row renders without one. A registry entry belongs
 * with the automation surface if Drive or Calendar ever gain automation
 * actions, not with the consent flow.
 *
 * @module integrations/providers/google/service
 */
import { Prisma } from '@prisma/client';

import type { RequestContext } from '../../../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { assertCanAdmin } from '../../../policies/common';
import { logEvent } from '../../../events/audit';
import { encryptField, decryptField } from '@/lib/security/encryption';
import { notFound, badRequest } from '@/lib/errors/types';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import type { TokenRefreshResult } from '@/lib/auth/refresh';
import {
    GOOGLE_PROVIDER,
    GOOGLE_CONNECTION_NAME,
    exchangeCodeForGoogleToken,
    resolveGoogleAccessToken,
    grantedProducts,
    type GoogleSecret,
} from './token';

/** The runtime flag gating this integration. Default OFF — the row must exist. */
export const GOOGLE_INTEGRATION_FLAG = 'integrations.google';

/**
 * Non-secret connection config.
 *
 * `grantedProducts` lives HERE rather than only inside the encrypted secret so
 * the admin list endpoint and the card can show which products actually work
 * without decrypting anything. Google's consent screen lets a user grant the
 * scopes individually, so this is not a formality: a connection can exist with
 * Calendar granted and Drive denied, and the UI has to say so rather than
 * letting the first export fail with a 403 nobody predicted.
 */
export interface GoogleConfigJson {
    grantedProducts: { drive: boolean; calendar: boolean };
    /** Full granted scope list, for diagnosis when the two disagree. */
    grantedScopes: string[];
}

/**
 * Complete the consent flow: exchange the code and persist a connection.
 *
 * Flag-gated as well as admin-gated. The flag is checked here rather than only
 * in the route because the callback is tenant-agnostic and re-authorises
 * independently — a gate that lived only in the connect route would be absent
 * from the path that actually writes the row.
 */
export async function completeGoogleConnect(
    ctx: RequestContext,
    input: { code: string; redirectUri: string; name?: string },
    deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ id: string; grantedProducts: GoogleConfigJson['grantedProducts'] }> {
    assertCanAdmin(ctx);
    await assertFeatureEnabled(GOOGLE_INTEGRATION_FLAG, ctx.userId);

    const secret = await exchangeCodeForGoogleToken(
        { code: input.code, redirectUri: input.redirectUri },
        { fetchImpl: deps.fetchImpl },
    );
    const products = grantedProducts(secret.grantedScopes);

    if (!products.drive && !products.calendar) {
        // Neither scope was granted — the user reached the consent screen and
        // ticked nothing. Refusing beats storing a connection that can do
        // nothing, which would show as connected and fail on first use.
        throw badRequest('Google returned no usable scopes — grant Drive or Calendar access to connect');
    }

    const config: GoogleConfigJson = {
        grantedProducts: products,
        grantedScopes: secret.grantedScopes,
    };

    return runInTenantContext(ctx, async (db) => {
        let row;
        try {
            row = await db.integrationConnection.create({
                data: {
                    tenantId: ctx.tenantId,
                    provider: GOOGLE_PROVIDER,
                    name: input.name?.trim() || GOOGLE_CONNECTION_NAME,
                    configJson: config as unknown as Prisma.InputJsonValue,
                    secretEncrypted: encryptField(JSON.stringify(secret)),
                    isEnabled: true,
                },
            });
        } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw badRequest('A Google connection with this name already exists');
            }
            throw e;
        }

        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_CREATED',
            entityType: 'IntegrationConnection',
            entityId: row.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'created',
                provider: GOOGLE_PROVIDER,
                // Which products, because a partial grant is the interesting
                // case and the audit trail should record what was actually
                // obtained rather than what was asked for.
                summary: `Connected Google (drive=${products.drive}, calendar=${products.calendar})`,
            },
        });
        return { id: row.id, grantedProducts: products };
    });
}

/**
 * Resolve a usable access token for a tenant's Google connection, refreshing
 * and persisting when it has expired.
 *
 * The stored row is authoritative and the rotated secret is written back
 * before the token is handed out — the discipline #1963 established, where a
 * refresh wrote one place and the decision read another.
 */
export async function resolveGoogleConnectionToken(
    ctx: RequestContext,
    connectionId: string,
    deps: { refresh?: (refreshToken: string) => Promise<TokenRefreshResult> } = {},
): Promise<{ accessToken: string; grantedProducts: GoogleConfigJson['grantedProducts'] }> {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const conn = await loadConnection(db, ctx, connectionId);
        const current = JSON.parse(decryptField(conn.secretEncrypted!)) as GoogleSecret;

        const { accessToken } = await resolveGoogleAccessToken(current, {
            refresh: deps.refresh,
            persist: async (rotated) => {
                await db.integrationConnection.update({
                    where: { id: conn.id },
                    data: { secretEncrypted: encryptField(JSON.stringify(rotated)) },
                });
            },
        });

        const cfg = conn.configJson as unknown as GoogleConfigJson | null;
        return {
            accessToken,
            // Default-deny if the config is missing or malformed: a connection
            // whose granted products cannot be read must not read as "both
            // work".
            grantedProducts: cfg?.grantedProducts ?? { drive: false, calendar: false },
        };
    });
}

/**
 * List this tenant's Google connections. No secrets — `configJson` carries
 * `grantedProducts`, which is the whole reason it lives there.
 */
export async function listGoogleConnections(ctx: RequestContext) {
    return runInTenantContext(ctx, (db) =>
        db.integrationConnection.findMany({
            where: { tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER },
            select: {
                id: true,
                name: true,
                isEnabled: true,
                configJson: true,
                lastTestedAt: true,
                lastTestStatus: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
        }),
    );
}

/**
 * Disconnect, deleting the stored credential with the row.
 *
 * Deliberately does NOT go through `loadConnection`: that helper refuses a
 * connection with no `secretEncrypted`, which is right for "use this
 * connection" and wrong for "remove it". A disconnect that declines because
 * the credential is already missing leaves a broken row the admin cannot clear
 * from the UI.
 *
 * No flag gate either. Turning the integration off must not strand connections
 * that can no longer be removed.
 */
export async function disconnectGoogle(ctx: RequestContext, connectionId: string): Promise<void> {
    assertCanAdmin(ctx);
    await runInTenantContext(ctx, async (db) => {
        const conn = await db.integrationConnection.findFirst({
            where: { id: connectionId, tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER },
            select: { id: true },
        });
        if (!conn) throw notFound('Google connection not found');

        await db.integrationConnection.delete({ where: { id: conn.id } });
        await logEvent(db, ctx, {
            action: 'INTEGRATION_CONNECTION_DELETED',
            entityType: 'IntegrationConnection',
            entityId: conn.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'IntegrationConnection',
                operation: 'deleted',
                provider: GOOGLE_PROVIDER,
                summary: 'Disconnected Google',
            },
        });
    });
}

/** Load a connection, scoped to the tenant and this provider. */
async function loadConnection(db: PrismaTx, ctx: RequestContext, connectionId: string) {
    const conn = await db.integrationConnection.findFirst({
        where: { id: connectionId, tenantId: ctx.tenantId, provider: GOOGLE_PROVIDER },
    });
    if (!conn) throw notFound('Google connection not found');
    if (!conn.secretEncrypted) throw badRequest('Google connection has no stored credentials');
    return conn;
}

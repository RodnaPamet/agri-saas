/**
 * «Документи» settings — the retention period, the Drive toggle, and the
 * farm's own storage usage (#2495 step 3).
 *
 * GET is readable by every member, because the page shows the current
 * retention and how full the farm is; PUT is admin-only, because changing
 * either is a farm-wide decision.
 */
import { NextRequest } from 'next/server';

import {
    getFarmDocumentSettings,
    updateFarmDocumentSettings,
} from '@/app-layer/usecases/farm-documents';
import { listGoogleConnections } from '@/app-layer/integrations/providers/google/service';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';
import type { RequestContext } from '@/app-layer/types';

/**
 * Whether a Drive copy is possible at all for this farm.
 *
 * `connected` means an ENABLED Google connection exists whose
 * `grantedProducts.drive` is true — not merely that a connection row exists.
 * A calendar-only grant cannot copy a document, and reporting it as connected
 * would offer the farmer a toggle that silently never copies anything.
 *
 * `accountEmail` is deliberately ABSENT. The contract has it optional, and
 * `GoogleConfigJson` carries `grantedProducts` and `grantedScopes` — no email.
 * Adding one would mean storing a Google account address, which is personal
 * data and a decision rather than a lookup; the page can say "connected"
 * without naming whose account it is.
 */
async function googleDriveState(ctx: RequestContext): Promise<{ connected: boolean }> {
    try {
        const connections = await listGoogleConnections(ctx);
        return {
            connected: connections.some((c) => {
                if (!c.isEnabled) return false;
                const cfg = c.configJson as { grantedProducts?: { drive?: boolean } } | null;
                return cfg?.grantedProducts?.drive === true;
            }),
        };
    } catch {
        // Fails SOFT, and reports NOT connected. The settings screen's job is
        // the retention period and the storage figure; an integrations read
        // that throws must not take the page down with it. `false` is also the
        // honest answer to "can we copy right now" when we cannot tell.
        return { connected: false };
    }
}

export const GET = withApiErrorHandling(
    requirePermission('documents.view', async (req: NextRequest, _routeArgs, ctx) => {
        const [settings, google] = await Promise.all([
            getFarmDocumentSettings(ctx),
            googleDriveState(ctx),
        ]);
        return jsonWithETag(req, { ...settings, google });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('documents.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = (await req.json()) as { retention?: unknown; driveSync?: unknown };
        const settings = await updateFarmDocumentSettings(ctx, body);
        const google = await googleDriveState(ctx);
        return jsonResponse({ ...settings, google });
    }),
);

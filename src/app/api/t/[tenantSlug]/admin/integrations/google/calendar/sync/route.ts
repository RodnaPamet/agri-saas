import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { syncFarmCalendar } from '@/app-layer/usecases/calendar-google-sync';

export const runtime = 'nodejs';
/**
 * The sync reads nine Prisma sources and then makes one Google call per
 * changed event, so a first run on an established farm is the slow case. 60s
 * matches the Drive export next door for the same reason.
 */
export const maxDuration = 60;

/**
 * Bring the farm's Google Calendar into line with its deadlines (#2020).
 *
 * ## Sited under the integration, not under `/calendar`
 *
 * The Drive export is sited beside the document it exports, because the handle
 * it needs is a path segment of that document. This has no such handle: it
 * acts on the whole farm, and the thing it configures is the Google
 * connection. So it sits with the other Google admin routes — the card that
 * calls it is the same card that holds «Свържи» and «Разкачи».
 *
 * ## `admin.manage`, and the gates are NOT repeated here
 *
 * `requirePermission` is what writes the `AUTHZ_DENIED` audit row on a denial,
 * which is why it wraps the handler rather than the usecase's own
 * `assertCanAdmin` being relied on alone — the two agree by construction,
 * since `resolveGoogleConnectionToken` requires admin to decrypt a
 * tenant-wide secret and neither gate can be the looser one.
 *
 * Everything else — the `integrations.google` flag, the Calendar grant, the
 * connection lookup — is in the usecase and deliberately not duplicated here.
 * A gate in two places is a gate that can disagree with itself.
 *
 * ## POST, and no body
 *
 * There is nothing to parameterise: the window is a constant, the calendar is
 * whichever one the connection names, and the language is persisted. A body
 * would be a surface to validate for no gain. It is a POST rather than a GET
 * because it writes — to Google, and to `configJson` on a first run.
 *
 * **Not idempotent in the HTTP sense, and safe to repeat anyway.** Two syncs
 * in a row leave the calendar in the same state, because the second one finds
 * every event already matching and reports `unchanged`. That is a property of
 * the diff, not of a dedupe key, so no `Idempotency-Key` is involved.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await syncFarmCalendar(ctx)),
    ),
);

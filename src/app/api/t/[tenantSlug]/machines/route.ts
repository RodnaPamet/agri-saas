/**
 * The fleet read — #2948 stage 3. One call for every locatable machine's
 * configuration and liveness, so the phone's machine list is a single request
 * rather than one per machine.
 *
 * `requirePermission` rather than a hand-rolled check, so the route is covered
 * by the Epic C.1 guardrail and its rule is findable in
 * `route-permissions.ts`. MECHANISATOR is excluded TWICE and neither layer
 * alone is load-bearing: `isOperatorAllowedPath` admits no `machines` prefix,
 * and the role holds `machines.view: false`. A mechanisator sees only the
 * machine on their own open task, through the `farm-tasks` reads.
 */
import { NextRequest } from 'next/server';

import { listMachines } from '@/app-layer/usecases/machines';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonWithETag } from '@/lib/http/etag';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'machines.view',
        async (req: NextRequest, _routeArgs, ctx) => {
            const payload = await listMachines(ctx);
            // A hot list read on a phone, so it carries a weak ETag like
            // journal / farm-tasks / locations / documents do — a relaunch on
            // rural LTE revalidates to a 304 instead of re-sending the fleet.
            return jsonWithETag(req, payload);
        },
    ),
);

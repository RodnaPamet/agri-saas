import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { listCalendarOverrides, setCalendarOverride } from '@/app-layer/usecases/agro-calendar-overrides';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError, type PlatformKeyGeneration } from '@/lib/auth/platform-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

/**
 * The agro calendar's overrides for SCRIPTS — #3095 stage 2, the keyed door.
 * The author recorded is the key GENERATION (`platform-key:current`), not a
 * person: there is one `PLATFORM_ADMIN_API_KEY` (#1619, #2735). The session
 * sibling under `/api/t/{slug}/admin/agro-calendar/overrides` names the user.
 */
const Body = z.object({
    cropKey: z.string().min(1).max(80),
    window: z.unknown(),
    basis: z.object({ bg: z.string().max(1000), en: z.string().max(1000).nullable().optional() }),
});

function platformGate(req: NextRequest): { generation: PlatformKeyGeneration } | NextResponse {
    try {
        return verifyPlatformApiKey(req);
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const gate = platformGate(req);
        if (gate instanceof NextResponse) return gate;
        return jsonResponse({ overrides: await listCalendarOverrides() });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-agro-calendar' } },
);

export const PUT = withApiErrorHandling(
    async (req: NextRequest) => {
        const gate = platformGate(req);
        if (gate instanceof NextResponse) return gate;
        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }
        const parsed = Body.safeParse(raw);
        if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        const override = await setCalendarOverride(parsed.data, { kind: 'platform-key', generation: gate.generation });
        return jsonResponse({ override });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-agro-calendar' } },
);

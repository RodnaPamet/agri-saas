import { NextRequest, NextResponse } from 'next/server';

import { clearCalendarOverride } from '@/app-layer/usecases/agro-calendar-overrides';
import { verifyPlatformApiKey, PlatformAdminError, type PlatformKeyGeneration } from '@/lib/auth/platform-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

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

export const runtime = 'nodejs';

/** Clear a window's override, keyed door (#3095). 204, or 404 when nothing is live. */
export const DELETE = withApiErrorHandling(
    async (req: NextRequest, { params }: { params: Promise<{ windowId: string }> }) => {
        const gate = platformGate(req);
        if (gate instanceof NextResponse) return gate;
        const { windowId } = await params;
        await clearCalendarOverride(windowId, { kind: 'platform-key', generation: gate.generation });
        return new Response(null, { status: 204 });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-agro-calendar' } },
);

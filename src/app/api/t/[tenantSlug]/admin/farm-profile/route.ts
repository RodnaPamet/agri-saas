import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getFarmProfile, upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { UpdateFarmProfileSchema } from '@/app-layer/schemas/farm-profile.schemas';

/**
 * `If-Match` on this route, parsed STRICTLY — and strictly matters more here
 * than on the other two routes that have a lock, because `0` is a SENTINEL
 * meaning "no row exists yet".
 *
 * ── what is accepted ──
 *
 *   If-Match: 5        bare integer, the house convention (journal,
 *                      field-operations, and both clients' outboxes send this)
 *   If-Match: "5"      a strong entity-tag, which is the RFC 7232 wire format
 *
 * ── what is REFUSED with a 400, rather than ignored ──
 *
 *   If-Match: W/"5"    a WEAK tag. RFC 7232 forbids weak comparison for
 *                      If-Match, and weak is meaningless for a version lock.
 *   If-Match: 0abc     anything else non-numeric, negative, hex or padded.
 *
 * The refusal is the point. Both existing locked routes FALL THROUGH to
 * "no precondition" on a header they cannot parse, so a client asking for
 * protection is silently given none and told nothing — see #1182. Absent means
 * "no precondition, last-write-wins" and that is fine and documented; present
 * but unparseable is a caller who clearly intended one, and guessing on their
 * behalf is how a lost update happens quietly.
 *
 * `field-operations` additionally COERCES: its `parseInt` turns `0abc` and
 * `0x0` into 0 and accepts `-1`. Under this design a malformed header coerced
 * to 0 would become a CREATE attempt, which is precisely why this does not
 * reuse that parser.
 */
function parseIfMatch(raw: string | null): number | undefined {
    if (raw === null) return undefined; // absent — unguarded, by design

    const value = raw.trim();
    if (/^W\//i.test(value)) {
        throw badRequest(
            'A weak entity-tag cannot be used with If-Match. Send the version as a bare integer or a strong tag.',
            { header: 'If-Match' },
        );
    }

    // A strong entity-tag is the same number in quotes.
    const unquoted = /^"(.*)"$/.exec(value)?.[1] ?? value;
    if (!/^\d+$/.test(unquoted)) {
        throw badRequest(
            'If-Match must be the profile version as a bare integer (5) or a strong entity-tag ("5").',
            { header: 'If-Match' },
        );
    }
    return Number.parseInt(unquoted, 10);
}

/** The strong entity-tag for a version, so a client may echo it back verbatim. */
const etagFor = (version: number): string => `"${version}"`;

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const profile = await getFarmProfile(ctx);
        // `version` is in the body AND the ETag header. The body is what the
        // existing clients read; the header is what an HTTP client that already
        // speaks preconditions will reach for, and it round-trips verbatim
        // because the quoted form is accepted above.
        return jsonResponse(profile, { headers: { ETag: etagFor(profile.version) } });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
        const body = UpdateFarmProfileSchema.parse(await req.json());
        const profile = await upsertFarmProfile(ctx, body, expectedVersion);
        // The NEW tag, so a client need not re-GET before its next write.
        return jsonResponse(profile, { headers: { ETag: etagFor(profile.version) } });
    }),
);

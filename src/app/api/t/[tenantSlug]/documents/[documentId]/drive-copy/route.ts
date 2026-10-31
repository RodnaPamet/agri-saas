/**
 * Retry a failed Google Drive copy (#2495, step 4).
 *
 * It does NOT copy. It sets `driveState = PENDING`, and the two-minute
 * `document-drive-copy-sweep` is what copies — so the request returns as soon
 * as the intent is durable rather than holding a connection open across a read
 * of the bytes and an upload to a third party. A route that performed the copy
 * inline would also be a second code path to the same Drive call, and the two
 * would eventually disagree about what a 403 means.
 *
 * Gated on `documents.upload` because that is the matcher's floor for this
 * prefix, with `requeueDocumentDriveCopy` enforcing ADMIN — the same split the
 * sibling DELETE route uses, and for a sharper reason here: the copy resolves
 * the farm's Google credential, and `resolveGoogleConnectionToken` asserts
 * admin because it decrypts and rotates a tenant-wide secret. A writer who is
 * not an admin cannot cause that token to be used.
 *
 * Three distinct 409 codes rather than one, because the states a caller can be
 * in want three different next actions — «изчакайте», «вече е копиран» and
 * «включете синхронизирането». #2564 is what one shared code costs: a single
 * catalogue sentence cannot carry three remedies, and the one it carries is
 * wrong for the other two readers.
 */
import { NextRequest } from 'next/server';

import { requeueDocumentDriveCopy } from '@/app-layer/usecases/document-drive-copy';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; documentId: string }>(
        'documents.upload',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await requeueDocumentDriveCopy(ctx, params.documentId);
            // The new STATE, not an `ok: true`. The client's row renders from
            // `drive.state`, so answering with it lets the retry button update
            // in place instead of refetching the list to learn what it just
            // caused.
            return jsonResponse(result);
        },
    ),
);

/**
 * POST /api/t/[tenantSlug]/locations/[id]/spatial-import
 *
 * Stages a parcel-boundary upload (shapefile .zip / KML / GeoJSON) and
 * enqueues the off-thread `spatial-import` job. The handler's contract
 * is just "validate cheaply + stage + enqueue"; the worker parses,
 * validates topology, and replaces the location's parcels.
 *
 * Abuse hardening (Epic harden-security #2): the parse never runs on the
 * request thread, and the per-format byte cap (shapefile 5 MB /
 * GeoJSON·KML 10 MB) is enforced HERE, before the body is even buffered,
 * so an oversized upload gets an immediate 413.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { stageLocationSpatialImport } from '@/app-layer/usecases/spatial-import';
import { withApiErrorHandling } from '@/lib/errors/api';
import {
    codedBadRequest,
    codedClientError,
    codedUnsupportedMediaType,
} from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';
import { detectFormat } from '@/lib/spatial/parse';
import { assertUploadWithinSize, SpatialLimitError } from '@/lib/spatial/limits';

const ALLOWED_EXT = ['.zip', '.kml', '.kmz', '.geojson', '.json'];

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const formData = await req.formData();
    const file = formData.get('file');
    // CODED refusals (#1447). Owner-authorised 2026-10-11, and the reason is a
    // farmer: agrent-ios passes a refusal SENTENCE straight through when there
    // is no code to translate by, so «File exceeds the 5 MB limit» was being
    // shown in English on a Bulgarian upload screen. These are the only bare
    // refusals the phone can reach.
    //
    // The message stays as the English fallback for a client that does not
    // recognise the code; the client composes its own sentence from the code
    // and `params`.
    if (!file || !(file instanceof File)) {
        throw codedBadRequest('FILE_REQUIRED', 'No file was included in the form data.');
    }
    if (file.size === 0) {
        throw codedBadRequest('FILE_EMPTY', 'The uploaded file has no content.');
    }
    const lower = (file.name || '').toLowerCase();
    if (!ALLOWED_EXT.some((ext) => lower.endsWith(ext))) {
        // 415, NOT 400: the status is documented and a client may branch on it
        // before reading the body. `allowed` travels as a param so the client
        // can list the extensions itself rather than parsing them out of an
        // English sentence.
        throw codedUnsupportedMediaType(
            'UNSUPPORTED_FILE_TYPE',
            'Upload a shapefile (.zip), KML (.kml/.kmz), or GeoJSON (.geojson/.json).',
            { allowed: ALLOWED_EXT.join(' ') },
        );
    }

    // Per-format byte cap — enforced on `file.size` BEFORE buffering the
    // body, so a hostile/oversized upload is refused without ever loading
    // its bytes into memory. detectFormat is non-null here (extension
    // already validated above).
    const format = detectFormat(file.name, file.type || undefined)!;
    try {
        assertUploadWithinSize(format, file.size);
    } catch (err) {
        if (err instanceof SpatialLimitError) {
            // THE one a farmer actually meets, and the one a literal-string
            // detector cannot see: `{ error: err.message }` is a VARIABLE, so
            // #1447's `{ error: '<string>' }` scan — and my own re-measurement
            // of it — both missed this line while counting the three above.
            // #1447 said its numbers were "a floor for that pattern, not the
            // total of all shape divergence"; this is what that means in
            // practice, and it was the most user-visible instance of all.
            throw codedClientError(
                err.statusCode,
                err.code ?? 'SPATIAL_UPLOAD_REJECTED',
                err.message,
                err.params,
            );
        }
        throw err;
    }

    // Optional default crop for every imported parcel (#7). A blank value
    // (the "mixed / set later" choice) is treated as unset by the usecase.
    const cropRaw = formData.get('cropType');
    const cropType = typeof cropRaw === 'string' && cropRaw.trim().length > 0 ? cropRaw.trim() : undefined;

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await stageLocationSpatialImport(ctx, params.id, {
        filename: file.name,
        buffer,
        mimeType: file.type || undefined,
        cropType,
    });

    // 202 Accepted — the parse + persist runs off-thread. The client
    // polls GET .../spatial-import/:jobId for completion.
    return jsonResponse({ ...result, status: 'queued' }, { status: 202 });
});

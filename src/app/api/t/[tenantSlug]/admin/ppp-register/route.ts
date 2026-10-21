/**
 * The БАБХ ПРЗ register — operator upload and state (#2077).
 *
 * Platform curation, not tenant work: `PppRegisterEntry` has no `tenantId`, so
 * a tenant-facing writer would let one farm rewrite the approved doses every
 * other farm reads. Sits under `/api/t/[tenantSlug]/admin/**` rather than
 * `/api/admin/**` because the gate is session-ful — see the usecase docblock
 * for why a header key could not carry this write's audit row.
 *
 * Both halves of the gate are load-bearing. `admin.manage` resolves from Role
 * and is therefore held by the OWNER of EVERY tenant, so alone it would hand
 * any farm's owner the national register; `assertPlatformSupport(ctx)` inside
 * the usecase restricts it to `PLATFORM_TENANT_SLUG` and 404s elsewhere.
 *
 * ── It scans, and the first draft of this file argued it should not ──────
 *
 * That argument was: nothing is stored or served, the bytes are parsed
 * in-request and discarded, and the one hazard of opening a ZIP —
 * decompression bombs — is already bounded by `readXlsxSheet`'s byte and row
 * caps, so a scan would be theatre.
 *
 * `tests/guards/upload-route-scan-reachability.test.ts` refused it, and the
 * guard is right on both counts. Its own docblock names the failure: *"passing
 * a file whose only mention of scanning is a docblock claiming it happens"* —
 * a docblock explaining why a scan is unnecessary is the same artefact from
 * the other side, and the avatar route went from launch to 2026-08-12 calling
 * no scanner at all on reasoning of exactly this shape. And on the merits:
 * "never stored" is not "never parsed". These bytes go through `jszip` and
 * `fast-xml-parser` in-process, which is a larger attack surface than the
 * storage write I was reasoning about.
 *
 * `exposure: 'private'` because nothing is retained or served. That is the
 * branch which tolerates a `SKIPPED` verdict when no scanner is deployed —
 * correct here, where the alternative is refusing an operator's upload on an
 * infrastructure fact, and wrong only for bytes that end up public.
 *
 * @module app/api/t/[tenantSlug]/admin/ppp-register
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { scanOrRefuse } from '@/lib/upload/ingest';
import { badRequest } from '@/lib/errors/types';
import {
    parsePppRegisterText,
    parsePppRegisterXlsx,
    PppRegisterParseError,
    MAX_REGISTER_TEXT_BYTES,
} from '@/lib/agro/ppp-register-parse';
import { importPppRegister, describePppRegister } from '@/app-layer/usecases/ppp-register-admin';

export const runtime = 'nodejs';

/** Upload ceiling. The published register is a few hundred KB. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Pick the parser from the FILENAME, not the declared content type.
 *
 * A browser's type for `.xlsx` is any of three strings depending on the OS, and
 * `curl -F` sends `application/octet-stream` by default — so the content type
 * is the less reliable of the two signals, which is the opposite of the usual
 * case. The extension is what an operator can see and fix.
 */
function isWorkbook(name: string): boolean {
    return /\.xlsx$/i.test(name.trim());
}

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        // BEFORE `formData()`, not merely before the usecase. The usecase
        // asserts this too, but by then the upload has been buffered, a ZIP
        // decompressed and several thousand rows parsed — work done on behalf
        // of a caller who is about to get a 404. The ordering is the point.
        assertPlatformSupport(ctx);

        const form = await req.formData();
        const file = form.get('file');
        if (!file || !(file instanceof File)) {
            throw badRequest('Missing `file` in the form data.');
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            throw badRequest(
                `The file is ${file.size} bytes; the limit is ${MAX_UPLOAD_BYTES}.`,
            );
        }

        const sheetField = form.get('sheet');
        const sheet = typeof sheetField === 'string' && sheetField.trim() ? sheetField.trim() : undefined;
        const sourceName = file.name.trim() || 'upload';
        const buf = Buffer.from(await file.arrayBuffer());
        // Before the parser, not after: the point is to get a verdict on the
        // bytes before `jszip` and `fast-xml-parser` are pointed at them.
        await scanOrRefuse(buf, { component: 'ppp-register-import', exposure: 'private' });
        const bytes = new Uint8Array(buf);

        let parsed;
        try {
            if (isWorkbook(sourceName)) {
                parsed = await parsePppRegisterXlsx(bytes, sheet);
            } else {
                if (bytes.byteLength > MAX_REGISTER_TEXT_BYTES) {
                    throw badRequest('The file is too large to parse as text.');
                }
                parsed = parsePppRegisterText(Buffer.from(bytes).toString('utf8'));
            }
        } catch (err) {
            // The parser's refusals name the headers it found and every
            // spelling it accepts. That message IS the operator's debugging,
            // so it is passed through as the 400 body rather than collapsed
            // into a generic one.
            if (err instanceof PppRegisterParseError) throw badRequest(err.message);
            throw err;
        }

        const result = await importPppRegister(ctx, { parsed, sourceName });
        return jsonResponse(result, { status: 201 });
    }),
);

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        return jsonResponse(await describePppRegister(ctx));
    }),
);

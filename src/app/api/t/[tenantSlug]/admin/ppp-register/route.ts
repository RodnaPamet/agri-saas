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
 * ── No AV scan, deliberately ─────────────────────────────────────────────
 *
 * `evidence/imports` scans because it STAGES a tenant-supplied archive in
 * storage for a worker to open later. Nothing here is stored or served: the
 * bytes are parsed in-request and discarded, and the one real hazard of
 * opening a ZIP — decompression bombs — is bounded by `readXlsxSheet`'s own
 * `DEFAULT_MAX_XLSX_BYTES` plus the row cap. A scan would be theatre over a
 * path that never writes a file.
 *
 * @module app/api/t/[tenantSlug]/admin/ppp-register
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
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
        const bytes = new Uint8Array(await file.arrayBuffer());

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

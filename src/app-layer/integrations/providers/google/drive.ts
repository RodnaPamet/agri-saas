/**
 * Putting one file in the farmer's Drive — #2019.
 *
 * The grant, its refresh and its storage are `token.ts` and `service.ts`
 * already. This is only the upload, which is the part #2019 was actually
 * missing: `service.ts` manages the GRANT and makes no Drive call at all.
 *
 * ## `drive.file` is narrower than it looks, and that is the point
 *
 * The scope is `https://www.googleapis.com/auth/drive.file`, which grants
 * access ONLY to files this app created. It cannot list a farmer's Drive, open
 * their existing documents, or see anything it did not write. So there is no
 * folder picker and no "save to this folder" — a thing worth stating because it
 * reads as a missing feature rather than as the deliberate limit it is.
 *
 * The alternative (`drive`, full access) would need Google's verification for a
 * restricted scope and would let a bug reach a farmer's whole Drive. For
 * handing someone a copy of their own register, `drive.file` is sufficient.
 *
 * ## Why the failures are distinguished
 *
 * One error shape for every cause means a client's logs name nothing. These
 * three need different responses from a person:
 *
 *   - **401** — the grant is gone. `resolveGoogleConnectionToken` already
 *     refreshes an expired token, so a 401 AFTER that means the refresh token
 *     was revoked, which only reconnecting fixes.
 *   - **403 with an insufficient-scope reason** — connected, but the Drive
 *     product was never granted. `grantedProducts.drive` should have caught it
 *     earlier; reaching here means that check was skipped.
 *   - **anything else** — Google is unhappy for its own reasons, and the
 *     status is reported rather than reinterpreted.
 */

import { codedBadRequest, externalServiceError } from '@/lib/errors/types';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';

export interface DriveFile {
    /** The filename as it will appear in Drive. */
    name: string;
    mimeType: string;
    bytes: Uint8Array;
}

export interface DriveUploadResult {
    fileId: string;
    /** Google's own link, or null when the response omitted it. */
    webViewLink: string | null;
}

/**
 * The multipart body Drive's `uploadType=multipart` expects: a JSON metadata
 * part, then the bytes, both under one boundary.
 *
 * Built by hand rather than with `FormData`, deliberately. `FormData` emits
 * `multipart/form-data`, and Drive requires `multipart/related` — they are
 * different media types and Drive rejects the former with a 400 that does not
 * say so. That cost an afternoon the last time anyone tried it, per Google's
 * own issue tracker.
 */
function multipartRelated(file: DriveFile, boundary: string): Uint8Array {
    const enc = new TextEncoder();
    const head = enc.encode(
        `--${boundary}\r\n`
            + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
            + `${JSON.stringify({ name: file.name, mimeType: file.mimeType })}\r\n`
            + `--${boundary}\r\n`
            + `Content-Type: ${file.mimeType}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + file.bytes.length + tail.length);
    body.set(head, 0);
    body.set(file.bytes, head.length);
    body.set(tail, head.length + file.bytes.length);
    return body;
}

export async function uploadToDrive(
    accessToken: string,
    file: DriveFile,
    deps: { fetchImpl?: typeof fetch; boundary?: string } = {},
): Promise<DriveUploadResult> {
    const fetchImpl = deps.fetchImpl ?? fetch;
    // Injectable so a test can assert the body EXACTLY rather than against a
    // random string. Random by default, because a fixed boundary appearing in
    // the file's own bytes would corrupt the request.
    const boundary = deps.boundary ?? `agrent-${crypto.randomUUID()}`;

    const res = await fetchImpl(UPLOAD_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartRelated(file, boundary) as unknown as BodyInit,
    });

    if (res.status === 401) {
        throw codedBadRequest(
            'GOOGLE_GRANT_REVOKED',
            'The Google connection is no longer authorised. Reconnect it to export again.',
        );
    }
    if (res.status === 403) {
        // Read the reason rather than assume it. A 403 here is usually a
        // missing scope, but Drive also 403s a storage quota — and telling a
        // farmer to reconnect when their Drive is full would be wrong advice.
        const detail = await res.text().catch(() => '');
        if (/insufficient|scope/i.test(detail)) {
            throw codedBadRequest(
                'GOOGLE_DRIVE_NOT_GRANTED',
                'The Google connection does not include Drive access. Reconnect it and grant Drive.',
            );
        }
        throw codedBadRequest(
            'GOOGLE_DRIVE_REFUSED',
            'Google refused the upload. Check the account’s Drive storage and try again.',
        );
    }
    if (!res.ok) {
        // Status reported, not reinterpreted.
        throw externalServiceError(`Google Drive upload failed with ${res.status}.`);
    }

    const json = (await res.json().catch(() => null)) as { id?: string; webViewLink?: string } | null;
    if (!json?.id) {
        // A 200 with no id is not a success. Returning a null fileId would make
        // the caller report an export that may not exist.
        throw externalServiceError('Google Drive accepted the upload but returned no file id.');
    }
    return { fileId: json.id, webViewLink: json.webViewLink ?? null };
}

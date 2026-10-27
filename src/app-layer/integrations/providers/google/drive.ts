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
 *
 * That mapping is `refuseDrive` and is shared by every call here, so the folder
 * calls and the upload cannot drift apart on what a 403 means. It was inline in
 * `uploadToDrive` when the upload was the only call.
 *
 * ## The folder, and why "missing" is not an error
 *
 * Exports accumulate in one folder the app creates, so they do not scatter
 * through the farmer's Drive root. Its id lives in
 * `IntegrationConnection.configJson`, which means the stored id can outlive the
 * folder: the farmer may delete it, and `drive.file` gives us no way to notice
 * until we try. So `ensureDriveFolder` treats **absent** and **in the bin** as
 * the same ordinary state as "never created" and makes a new one, rather than
 * reporting a failure for something the farmer is entitled to do with their own
 * Drive.
 *
 * The bin case is the one that would otherwise be silent. A trashed folder
 * still answers `files.get` with 200 — it is retrievable by id — so a check
 * that only caught 404 would upload the register into the farmer's bin and
 * report success. Nobody would see an error; they would just never find the
 * document. Hence `fields=id,trashed` rather than a bare existence check.
 */

import { codedBadRequest, externalServiceError } from '@/lib/errors/types';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
    /** The filename as it will appear in Drive. */
    name: string;
    mimeType: string;
    bytes: Uint8Array;
}

/**
 * The one place a Drive HTTP status becomes a coded refusal.
 *
 * Shared so the folder calls and the upload cannot disagree about what a 403
 * means — which they would, eventually, having been written months apart. The
 * `what` lands only in the unexpected-status message, so a 500 says which call
 * failed rather than just that Drive did.
 */
async function refuseDrive(res: Response, what: string): Promise<never> {
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
    // Status reported, not reinterpreted.
    throw externalServiceError(`Google Drive ${what} failed with ${res.status}.`);
}

export interface DriveFolderResult {
    folderId: string;
    /**
     * True when this call made the folder — because the id was absent, named
     * nothing, or named something in the bin. The caller persists the id on
     * `true`; it is also the honest thing to tell a person whose folder
     * reappeared empty.
     */
    created: boolean;
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
function multipartRelated(file: DriveFile, boundary: string, folderId: string | null): Uint8Array {
    const enc = new TextEncoder();
    // `parents` is spread in CONDITIONALLY rather than set to `undefined` and
    // left to `JSON.stringify` to drop. It does drop it — but relying on that
    // makes the absence of a key depend on a serialiser detail, and Drive reads
    // `parents: null` as a request it cannot satisfy rather than as "no
    // parent". Explicit is one line longer and says what it means.
    const metadata = {
        name: file.name,
        mimeType: file.mimeType,
        ...(folderId ? { parents: [folderId] } : {}),
    };
    const head = enc.encode(
        `--${boundary}\r\n`
            + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
            + `${JSON.stringify(metadata)}\r\n`
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
    opts: { folderId?: string | null; fetchImpl?: typeof fetch; boundary?: string } = {},
): Promise<DriveUploadResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    // Injectable so a test can assert the body EXACTLY rather than against a
    // random string. Random by default, because a fixed boundary appearing in
    // the file's own bytes would corrupt the request.
    const boundary = opts.boundary ?? `agrent-${crypto.randomUUID()}`;

    const res = await fetchImpl(UPLOAD_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: multipartRelated(file, boundary, opts.folderId ?? null) as unknown as BodyInit,
    });

    if (!res.ok) await refuseDrive(res, 'upload');

    const json = (await res.json().catch(() => null)) as { id?: string; webViewLink?: string } | null;
    if (!json?.id) {
        // A 200 with no id is not a success. Returning a null fileId would make
        // the caller report an export that may not exist.
        throw externalServiceError('Google Drive accepted the upload but returned no file id.');
    }
    return { fileId: json.id, webViewLink: json.webViewLink ?? null };
}

/**
 * The folder exports go into, creating it when the stored id names nothing
 * usable.
 *
 * `storedFolderId` is whatever `IntegrationConnection.configJson` holds, which
 * may be `null` (never exported) or stale (the farmer deleted or binned the
 * folder). All three are the same ordinary state and all three return a usable
 * id; `created` tells the caller whether to persist a new one.
 *
 * ## Why `created` is reported rather than inferred
 *
 * The caller cannot work it out from the id alone — a freshly created folder
 * and a verified existing one look identical. Persisting unconditionally would
 * also work, but it writes on every export to say nothing changed, and the
 * write is inside a tenant transaction.
 *
 * ## What a 404 does NOT mean
 *
 * It does not mean a broken connection, and it must not surface as one.
 * `drive.file` can only see files this app created, so a farmer tidying their
 * own Drive is both expected and invisible to us until the next export. Making
 * that an error would tell someone to reconnect a connection that is fine.
 */
export async function ensureDriveFolder(
    accessToken: string,
    storedFolderId: string | null,
    opts: { name: string; fetchImpl?: typeof fetch },
): Promise<DriveFolderResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;

    if (storedFolderId) {
        const res = await fetchImpl(
            `${FILES_URL}/${encodeURIComponent(storedFolderId)}?fields=id,trashed`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (res.ok) {
            const json = (await res.json().catch(() => null)) as
                | { id?: string; trashed?: boolean }
                | null;
            // `trashed` is why this asks for a field rather than just a status.
            // A binned folder answers 200, so an existence check alone would
            // upload the register into the farmer's bin and report success.
            if (json?.id && json.trashed !== true) {
                return { folderId: json.id, created: false };
            }
        } else if (res.status !== 404) {
            // 404 is the normal stale-id case and falls through to create.
            // Everything else is a real refusal and keeps its own meaning.
            await refuseDrive(res, 'folder lookup');
        }
    }

    const res = await fetchImpl(`${FILES_URL}?fields=id`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: opts.name, mimeType: FOLDER_MIME }),
    });
    if (!res.ok) await refuseDrive(res, 'folder create');

    const json = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!json?.id) {
        // Same reasoning as the upload's missing id: proceeding with a null
        // parent would silently put the export in the Drive root, which is the
        // thing the folder exists to prevent.
        throw externalServiceError('Google Drive created a folder but returned no id.');
    }
    return { folderId: json.id, created: true };
}

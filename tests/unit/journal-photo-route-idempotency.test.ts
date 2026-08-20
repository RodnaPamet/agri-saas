/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks mirror
 * runtime contracts; the codebase's standard file-level disable. */
/**
 * The photo route must READ `Idempotency-Key` and HAND IT ON.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * This is the third of the three offline-replay routes named by gap #6 of the
 * 2026-08-19 enforcement-seam audit. The other two are covered by
 * `idempotency-forwarding-enforced.test.ts` (#641), which deliberately
 * EXCLUDED this one — and was right to. Dedup here is CONTENT-ADDRESSED
 * (SHA-256 -> `FileRecord` reuse -> `@@unique([logEntryId, fileRecordId])` plus
 * an advisory lock), so the audit's prescribed assertion — "drive twice, assert
 * one row" — passes here with the header read DELETED. Written that way it
 * would have been a fourth test that looked like coverage and proved nothing.
 *
 * ── Why this seam needs TWO files, and must not be merged into one ──
 *
 * There are two independent mutants, and no single harness can kill both:
 *
 *   M1  the route stops reading the header, or stops passing it on
 *         (`journal/[id]/files/route.ts:41-42`)
 *   M2  the usecase stops spending it — delete the
 *       `...(idempotencyKey ? { idempotencyKey } : {})` spread at
 *       `journal.ts:699`, its ONLY consumption site
 *
 * A route test must mock `@/app-layer/usecases/journal` wholesale to spy on the
 * argument, which makes M2 unobservable. A usecase test must keep that module
 * REAL, which puts the route out of reach. One jest module registry cannot hold
 * both. So: **this file owns M1, `journal-photo-idempotency.test.ts` owns M2.**
 * Deleting either leaves half the seam uncovered while the other still passes.
 *
 * Measured, before this file existed: no test in the repo imported this route
 * module, and deleting the header read does not fail `tsc` — `idempotencyKey`
 * is a TRAILING OPTIONAL parameter (`journal.ts:575`), so omitting the argument
 * is well-typed by definition, and tsconfig sets no `noUnusedLocals` to catch
 * the orphaned const.
 *
 * ── Harness traps, each measured rather than assumed ──
 *
 *  1. NEVER set `content-type` by hand. `'multipart/form-data'` without a
 *     `boundary` makes `req.formData()` (route.ts:32) throw — a 500, not a 400
 *     and not a pass. Omitting the header lets undici emit the boundary itself,
 *     which is what satisfies the `includes('multipart/form-data')` branch at
 *     route.ts:31. This is the easiest way to write a test that appears to
 *     exercise this branch and never enters it.
 *  2. A FRESH `NextRequest` per call. The body stream is single-use; replaying
 *     one object yields 201 then 500. Same hazard the sibling documents.
 *  3. The rate limiter needs no mock — `rate-limit-middleware.ts:319-324`
 *     auto-bypasses under `NODE_ENV=test` — but every case still asserts 201,
 *     so a request failing for an unrelated reason (module gate, limiter,
 *     consumed body) cannot masquerade as a pass.
 */
import { NextRequest } from 'next/server';

const getTenantCtxMock = jest.fn();
const assertModuleEnabledMock = jest.fn();
const uploadLogEntryPhotoMock = jest.fn();
const attachLogEntryFileMock = jest.fn();

jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: any[]) => getTenantCtxMock(...a),
}));

jest.mock('@/app-layer/usecases/modules', () => ({
    __esModule: true,
    assertModuleEnabled: (...a: any[]) => assertModuleEnabledMock(...a),
}));

// All three exports must exist — route.ts destructures DELETE's handler too,
// and a missing key would make it `undefined` at module load.
jest.mock('@/app-layer/usecases/journal', () => ({
    __esModule: true,
    uploadLogEntryPhoto: (...a: any[]) => uploadLogEntryPhotoMock(...a),
    attachLogEntryFile: (...a: any[]) => attachLogEntryFileMock(...a),
    detachLogEntryFile: jest.fn(),
}));

// KEPT REAL: the route module itself, withApiErrorHandling (so the real
// error/rate-limit wrapper is exercised), jsonResponse, badRequest, and the
// whole observability stack. Mocking `@opentelemetry/api` here would break the
// suite outright — `errors/api.ts` imports the observability SUBMODULES, so a
// barrel mock does not intercept and a hand-built `trace` literal loses
// `createContextKey`.
import { POST } from '@/app/api/t/[tenantSlug]/journal/[id]/files/route';

const URL_ = 'http://localhost/api/t/acme/journal/log-1/files';
const OUTBOX_ID = 'outbox-item-42';

/** Argument positions on `uploadLogEntryPhoto(ctx, logEntryId, file, caption, idempotencyKey)`. */
const ARG_CAPTION = 3;
const ARG_KEY = 4;

function multipart(key?: string, caption?: string): NextRequest {
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'photo.jpg', { type: 'image/jpeg' }));
    if (caption !== undefined) fd.set('caption', caption);
    const headers: Record<string, string> = {};
    if (key) headers['Idempotency-Key'] = key;
    // No content-type — see trap 1.
    return new NextRequest(URL_, { method: 'POST', headers, body: fd });
}

const args = () => ({ params: Promise.resolve({ tenantSlug: 'acme', id: 'log-1' }) }) as any;

beforeEach(() => {
    jest.clearAllMocks();
    getTenantCtxMock.mockResolvedValue({ userId: 'user-1', tenantId: 'tenant-1', role: 'EDITOR' });
    assertModuleEnabledMock.mockResolvedValue(undefined);
    uploadLogEntryPhotoMock.mockResolvedValue({ id: 'link-1', fileRecordId: 'file-1', isImage: true });
});

describe('journal photo route — the Idempotency-Key reaches the usecase', () => {
    it('forwards the header verbatim as the 5th argument', async () => {
        const res = await POST(multipart(OUTBOX_ID), args());

        // Asserted first: without it, a request that failed for an unrelated
        // reason would leave the mock uncalled and the assertion below vacuous.
        expect(res.status).toBe(201);
        expect(uploadLogEntryPhotoMock).toHaveBeenCalledTimes(1);
        expect(uploadLogEntryPhotoMock.mock.calls[0][ARG_KEY]).toBe(OUTBOX_ID);
    });

    it('forwards the SAME key on a replay, so the usecase can recognise it', async () => {
        // Two independent requests carrying one key — the sequential replay an
        // outbox actually performs after a response is lost on flaky LTE.
        const first = await POST(multipart(OUTBOX_ID), args());
        const second = await POST(multipart(OUTBOX_ID), args());

        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(uploadLogEntryPhotoMock.mock.calls.map((c) => c[ARG_KEY])).toEqual([OUTBOX_ID, OUTBOX_ID]);
    });

    it('passes something FALSY — never a stringified one — when the header is absent', async () => {
        // The invariant is truthiness, not identity. `journal.ts:699` spreads
        // on truthiness, so `null` and `undefined` are equivalent here: both
        // omit the audit field, and both are correct.
        //
        // Asserting `toBeNull()` would therefore be over-tight. The sibling
        // routes write `req.headers.get(...) || undefined`; unifying this one
        // with them is a behaviour-preserving refactor, and a test that failed
        // on it would be a guard firing on a no-op — which teaches the next
        // reader to edit the guard rather than think about it.
        //
        // What must NEVER happen is a truthy stand-in. `String(...)` or a
        // `?? 'null'` default writes a literal "null" into the audit trail of
        // the БАБХ farm diary, where it reads as a real outbox id. That is the
        // assertion with teeth, and it survives the unification.
        const res = await POST(multipart(), args());

        expect(res.status).toBe(201);
        const key = uploadLogEntryPhotoMock.mock.calls[0][ARG_KEY];
        expect(key).toBeFalsy();
        expect(key).not.toBe('null');
        expect(key).not.toBe('undefined');
    });

    it('does not shift the argument positions — caption still lands in slot 4', async () => {
        // The key is the LAST positional argument, so an inserted or removed
        // parameter upstream slides it silently. Pinning its neighbour means a
        // signature change fails here rather than forwarding the caption into
        // the idempotency slot.
        await POST(multipart(OUTBOX_ID, 'aphids on block A'), args());

        expect(uploadLogEntryPhotoMock.mock.calls[0][ARG_CAPTION]).toBe('aphids on block A');
        expect(uploadLogEntryPhotoMock.mock.calls[0][ARG_KEY]).toBe(OUTBOX_ID);
    });

    it('took the multipart branch, not the JSON one', async () => {
        // The positive control for trap 1. If the boundary were ever lost, the
        // request would miss `includes('multipart/form-data')` and fall through
        // to the JSON branch — where every assertion above is vacuous because
        // `uploadLogEntryPhoto` is never reached at all.
        await POST(multipart(OUTBOX_ID), args());

        expect(uploadLogEntryPhotoMock).toHaveBeenCalled();
        expect(attachLogEntryFileMock).not.toHaveBeenCalled();
    });
});

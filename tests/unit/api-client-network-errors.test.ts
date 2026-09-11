/**
 * A failed request must never put the platform's own error string on screen.
 *
 * Reported from a physical iPhone in airplane mode, 2026-09-11: the operator
 * edited a journal entry, pressed SAVE, and got a red banner reading
 *
 *     Load failed
 *
 * That is not copy this repo wrote. It is WebKit's TypeError message for a
 * rejected fetch — Chrome says "Failed to fetch" — and it reached the screen
 * because `apiPatch` did not wrap its fetch, so the rejection escaped untyped
 * into `setError(err.message)`. Two words, about LOADING, shown to someone who
 * pressed SAVE, in English, saying nothing about what happened to their work.
 *
 * A non-2xx was always converted (`ApiClientError`). A rejection never was.
 */
import { apiGet, apiPost, apiPatch, apiDelete, ApiClientError, API_OFFLINE_CODE, API_TIMEOUT_CODE, isOfflineError } from '@/lib/api-client';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

/** WebKit's actual shape for a network failure. */
function offlineFetch() {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Load failed'));
}
function rejectWith(name: string) {
    const err = new Error(name);
    err.name = name;
    global.fetch = jest.fn().mockRejectedValue(err);
}

describe('a rejected fetch becomes a typed error, not a raw browser string', () => {
    it.each([
        ['apiGet', () => apiGet('/x')],
        ['apiPost', () => apiPost('/x', {})],
        ['apiPatch', () => apiPatch('/x', {})],
        ['apiDelete', () => apiDelete('/x')],
    ])('%s surfaces ApiClientError(OFFLINE), never "Load failed"', async (_name, call) => {
        offlineFetch();
        await expect(call()).rejects.toBeInstanceOf(ApiClientError);
        await expect(call()).rejects.toMatchObject({ code: API_OFFLINE_CODE, status: 0 });
        // The whole point: the operator must not be shown WebKit's phrase.
        await expect(call()).rejects.not.toThrow('Load failed');
    });

    it('a TIMEOUT is not relabelled as being offline', async () => {
        // AbortSignal.timeout() rejects with TimeoutError. "You are offline" is
        // its own wrong answer — the server was reachable and too slow.
        rejectWith('TimeoutError');
        await expect(apiGet('/x')).rejects.toMatchObject({ code: API_TIMEOUT_CODE, status: 0 });
    });

    it('a deliberate abort is rethrown untouched, not turned into an error banner', async () => {
        // A caller-owned signal aborting is cancellation, not failure. Wrapping
        // it would make every cancelled request look like a fault to the user.
        rejectWith('AbortError');
        await expect(apiGet('/x')).rejects.not.toBeInstanceOf(ApiClientError);
        await expect(apiGet('/x')).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('POSITIVE CONTROL: a successful response still resolves normally', async () => {
        // Without this the assertions above pass for a client that rejects
        // everything, which is not the fix — it is a different bug.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ ok: true }),
        } as unknown as Response);
        await expect(apiGet<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
    });
});

describe('isOfflineError does not depend on class identity', () => {
    // The obvious check — `err instanceof ApiClientError && err.code === OFFLINE`
    // — has two blind spots that produce the SAME symptom: the operator is shown
    // the English default instead of translated copy.
    //
    //   1. instanceof compares class identity. Two bundle chunks each holding a
    //      copy of this module means an error thrown by one is not an instance
    //      of the other's class, and the branch silently takes the wrong arm.
    //   2. A caller using a bare fetch() never gets a typed error at all.
    //
    // Both still have to be recognised, so match on SHAPE, not on the class.

    it('recognises a genuine ApiClientError(OFFLINE)', async () => {
        offlineFetch();
        const err = await apiGet('/x').catch((e) => e);
        expect(isOfflineError(err)).toBe(true);
    });

    it('recognises a DUPLICATED-MODULE error it has never seen the class of', () => {
        // What a second bundle chunk's copy produces: right shape, alien class.
        class OtherChunkApiClientError extends Error {
            code = API_OFFLINE_CODE;
            status = 0;
        }
        const alien = new OtherChunkApiClientError('No connection');
        expect(alien).not.toBeInstanceOf(ApiClientError); // the blind spot, made explicit
        expect(isOfflineError(alien)).toBe(true);
    });

    it.each([
        ['WebKit', 'Load failed'],
        ['Chromium', 'Failed to fetch'],
        ['Firefox', 'NetworkError when attempting to fetch resource.'],
    ])('recognises a bare fetch rejection from %s', (_engine, message) => {
        expect(isOfflineError(new TypeError(message))).toBe(true);
    });

    it.each([
        ['a timeout', Object.assign(new Error('too slow'), { code: API_TIMEOUT_CODE })],
        ['a 404 from the server', new ApiClientError('Not found', 'NOT_FOUND', 404)],
        ['an unrelated TypeError', new TypeError("Cannot read properties of undefined")],
        ['a plain string', 'Load failed'],
        ['null', null],
    ])('does NOT claim %s is an offline failure', (_name, err) => {
        // Without these the function could return true unconditionally and
        // every test above would still pass.
        expect(isOfflineError(err)).toBe(false);
    });
});

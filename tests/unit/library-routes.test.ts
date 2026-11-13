/**
 * The two library routes — the gate, and the order it runs in (#2980).
 *
 * ## What needs a test here rather than in the integration suite
 *
 * Three properties that are about the ROUTE and not the query:
 *
 *   1. the flag is consulted, and the person asked about is the CALLER;
 *   2. it is consulted BEFORE the read, so a dark surface performs no query;
 *   3. the response carries an ETag, which is #2980 §3(b)'s whole point and is
 *      a property of the transport rather than of the data.
 *
 * Property 2 is the one that needs asserting rather than assuming. A route
 * that read first and gated afterwards would behave identically from outside
 * — same 404, same absence of a body — while doing the work an operator
 * switched off. So these cases assert the USECASE WAS NOT CALLED, which is the
 * `social-inbox-source-param` pattern for the same reason.
 *
 * ## Why the flag module is mocked rather than seeded
 *
 * `isFeatureEnabled` reads a Redis-cached table, and a unit test seeding a
 * `FeatureFlag` row would be asserting the flag MACHINERY, which has its own
 * coverage. What is in question here is whether this route consults it at all
 * and with which arguments.
 */
const mockGetUserCtx = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => mockGetUserCtx(...a),
}));

const mockAssertFeature = jest.fn();
jest.mock('@/lib/feature-flags', () => ({
    assertFeatureEnabled: (...a: unknown[]) => mockAssertFeature(...a),
}));

const mockListBooks = jest.fn();
const mockReadBook = jest.fn();
jest.mock('@/app-layer/usecases/library', () => ({
    listBooks: (...a: unknown[]) => mockListBooks(...a),
    readBook: (...a: unknown[]) => mockReadBook(...a),
}));

import { NextRequest } from 'next/server';

import { notFound } from '@/lib/errors/types';
import { GET as listGET } from '@/app/api/library/books/route';
import { GET as readGET } from '@/app/api/library/books/[slug]/route';

const CALLER = { userId: 'u-reader', requestId: 'req-1', email: 'r@example.test' };

/** The second argument Next hands a handler. */
const NO_SEGMENTS = { params: Promise.resolve({}) };

function req(url = 'http://localhost/api/library/books', headers?: Record<string, string>) {
    return new NextRequest(url, { headers });
}

const SUMMARY = {
    slug: 'a-book',
    title: 'Изкуството на войната',
    author: 'Сун Дзъ',
    locale: 'bg',
    summary: null,
    version: 1,
    updatedAt: '2026-11-13T00:00:00.000Z',
    useCases: ['STRATEGY'] as const,
};

beforeEach(() => {
    jest.clearAllMocks();
    // `mockReset` is NOT used: these doubles carry no throwing
    // implementation, so a reset would only cost the default `undefined`
    // return that `clearAllMocks` already leaves.
    mockGetUserCtx.mockResolvedValue(CALLER);
    mockAssertFeature.mockResolvedValue(undefined);
    mockListBooks.mockResolvedValue([SUMMARY]);
    mockReadBook.mockResolvedValue({
        ...SUMMARY,
        sourceNote: 'Публично достояние.',
        licenseNote: 'Собствен превод.',
        chapters: [{ number: 1, title: 'Планиране', originalTitle: null, paragraphs: ['Едно'] }],
    });
});

describe('GET /api/library/books', () => {
    it('gates on `library.enabled` for the CALLER', async () => {
        await listGET(req(), NO_SEGMENTS);

        expect(mockAssertFeature).toHaveBeenCalledWith('library.enabled', 'u-reader');
        // The caller, not a constant: the flag table supports cohorts, so a
        // gate asked about the wrong person is a rollout that admits the wrong
        // half of the deployment.
    });

    it('does NOT read when the flag refuses — the gate runs FIRST', async () => {
        // The assertion that cannot be made from outside: a route that queried
        // and then gated would answer identically.
        //
        // The double throws what `assertFeatureEnabled` really throws — a
        // `notFound`, so a dark surface is indistinguishable from an absent
        // one. A bare `Error` would reach `withApiErrorHandling` as an
        // unexpected failure and become a 500, which would make this case pass
        // for the wrong reason and hide a real 500 if one ever appeared.
        mockAssertFeature.mockRejectedValue(notFound('Not found'));

        const res = await listGET(req(), NO_SEGMENTS);

        expect(res.status).toBe(404);
        expect(mockListBooks).not.toHaveBeenCalled();
    });

    it('answers 200 with the books wrapped in an object', async () => {
        const res = await listGET(req(), NO_SEGMENTS);

        expect(res.status).toBe(200);
        // An object rather than a bare array, so a later `nextCursor` is an
        // added field instead of a changed TYPE.
        expect(await res.json()).toEqual({ books: [SUMMARY] });
    });

    it('carries an ETag, and answers 304 when the client echoes it', async () => {
        // #2980 §3(b). The catalogue changes when a book is added — months
        // apart — so nearly every revalidation should be a few dozen bytes.
        const first = await listGET(req(), NO_SEGMENTS);
        const etag = first.headers.get('etag');
        expect(etag).toBeTruthy();

        const second = await listGET(req(undefined, { 'if-none-match': etag! }), NO_SEGMENTS);
        expect(second.status).toBe(304);
        // A 304 has no body; asserting the status alone would pass for a 200
        // that merely happened to be empty.
        expect(await second.text()).toBe('');
    });
});

describe('GET /api/library/books/{slug}', () => {
    const SEGMENTS = { params: Promise.resolve({ slug: 'a-book' }) };

    it('gates on `library.enabled` and passes the slug through', async () => {
        await readGET(req('http://localhost/api/library/books/a-book'), SEGMENTS);

        expect(mockAssertFeature).toHaveBeenCalledWith('library.enabled', 'u-reader');
        expect(mockReadBook).toHaveBeenCalledWith(CALLER, 'a-book');
    });

    it('does NOT read when the flag refuses', async () => {
        mockAssertFeature.mockRejectedValue(notFound('Not found'));

        const res = await readGET(req('http://localhost/api/library/books/a-book'), SEGMENTS);

        // The SAME 404 a wrong slug gets. A client cannot tell "switched off"
        // from "no such book", and should not try.
        expect(res.status).toBe(404);
        expect(mockReadBook).not.toHaveBeenCalled();
    });

    it('carries an ETag — the read it matters most for', async () => {
        // The body here is a whole book, and it changes only when `version` is
        // bumped. A per-chapter route would have made this thirteen round
        // trips instead.
        const first = await readGET(req('http://localhost/api/library/books/a-book'), SEGMENTS);
        const etag = first.headers.get('etag');
        expect(etag).toBeTruthy();

        const second = await readGET(
            new NextRequest('http://localhost/api/library/books/a-book', {
                headers: { 'if-none-match': etag! },
            }),
            { params: Promise.resolve({ slug: 'a-book' }) },
        );
        expect(second.status).toBe(304);
    });

    it('awaits the params Promise — the Next 16 contract', async () => {
        // A handler that read `params.slug` off the Promise would get
        // `undefined` and query for a book called "undefined", which is a 404
        // and therefore indistinguishable from a wrong slug.
        await readGET(req('http://localhost/api/library/books/other'), {
            params: Promise.resolve({ slug: 'other' }),
        });
        expect(mockReadBook).toHaveBeenCalledWith(CALLER, 'other');
    });
});

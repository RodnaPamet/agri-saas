/**
 * Roadmap-6 P3 — ETag / 304 conditional-revalidation helper.
 *
 * Locks the invariant the whole feature rests on: a stable weak ETag
 * for a given body, an honored `If-None-Match` short-circuiting to a
 * bodyless 304, and a full 200 when the representation has changed.
 */
import {
    computeWeakETag,
    ifNoneMatchSatisfied,
    jsonWithETag,
} from '@/lib/http/etag';

function reqWith(ifNoneMatch?: string): Request {
    return new Request('http://localhost/api/t/acme/journal', {
        headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
    });
}

describe('computeWeakETag', () => {
    it('is deterministic — same body yields the same weak tag', () => {
        const body = JSON.stringify([{ id: 'a', title: 'Scouted aphids' }]);
        expect(computeWeakETag(body)).toBe(computeWeakETag(body));
    });

    it('always emits the weak-tag shape W/"<hash>-<len>"', () => {
        const tag = computeWeakETag('{"x":1}');
        expect(tag).toMatch(/^W\/"[0-9a-f]+-\d+"$/);
    });

    it('differs when the body differs', () => {
        expect(computeWeakETag('{"a":1}')).not.toBe(computeWeakETag('{"a":2}'));
    });

    it('distinguishes same-hash-different-length via the length suffix', () => {
        // Two distinct bodies must not collide; the length component is a
        // cheap second axis on top of the 53-bit hash.
        expect(computeWeakETag('[]')).not.toBe(computeWeakETag('[0]'));
    });
});

describe('ifNoneMatchSatisfied', () => {
    const etag = computeWeakETag('{"a":1}');

    it('is false when the header is absent', () => {
        expect(ifNoneMatchSatisfied(null, etag)).toBe(false);
        expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    });

    it('matches an identical weak tag', () => {
        expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
    });

    it('matches ignoring the W/ weakness prefix (weak comparison)', () => {
        const strongLooking = etag.replace(/^W\//, '');
        expect(ifNoneMatchSatisfied(strongLooking, etag)).toBe(true);
    });

    it('matches within a comma-separated list', () => {
        expect(ifNoneMatchSatisfied(`W/"other-1", ${etag}`, etag)).toBe(true);
    });

    it('matches the wildcard', () => {
        expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
    });

    it('does not match an unrelated tag', () => {
        expect(ifNoneMatchSatisfied('W/"nope-9"', etag)).toBe(false);
    });
});

describe('jsonWithETag', () => {
    it('returns 200 with an ETag + revalidation Cache-Control when no INM', async () => {
        const payload = [{ id: 'a', title: 'Row A' }];
        const res = jsonWithETag(reqWith(), payload);
        expect(res.status).toBe(200);
        const etag = res.headers.get('ETag');
        expect(etag).toBe(computeWeakETag(JSON.stringify(payload)));
        expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
        expect(res.headers.get('Content-Type')).toContain('application/json');
        expect(await res.json()).toEqual(payload);
    });

    it('round-trips: the 200 ETag, replayed as If-None-Match, yields 304', async () => {
        const payload = { items: [1, 2, 3], nextCursor: null };
        const first = jsonWithETag(reqWith(), payload);
        const etag = first.headers.get('ETag')!;

        const second = jsonWithETag(reqWith(etag), payload);
        expect(second.status).toBe(304);
        // 304 carries the validator but no body.
        expect(second.headers.get('ETag')).toBe(etag);
        expect(await second.text()).toBe('');
    });

    it('returns a fresh 200 when the body changed under the same stale INM', async () => {
        const staleTag = jsonWithETag(reqWith(), { v: 1 }).headers.get('ETag')!;
        // Client sends the old tag, but the data moved on.
        const res = jsonWithETag(reqWith(staleTag), { v: 2 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: 2 });
        expect(res.headers.get('ETag')).not.toBe(staleTag);
    });

    it('honors a caller-supplied status on the 200 path', () => {
        const res = jsonWithETag(reqWith(), { ok: true }, { status: 200 });
        expect(res.status).toBe(200);
    });
});

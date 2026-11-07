/**
 * The response-layer ciphertext detector — #2723 item 2.
 *
 * The owner chose this mechanism over a repo-wide static guard, and the reason
 * is in the issue: the discriminator a static guard needs is whether a read
 * through the global client happens to run inside `runInTenantContext`, which
 * is an ALS reachability question a regex cannot answer. An envelope reaching a
 * response needs no such analysis — it is always a defect.
 *
 * The risk in a detector like this is NOT missing one. It is a false positive
 * on a farmer's free text, so most of what follows is precision.
 */
import crypto from 'crypto';
import {
    ENVELOPE_MIN_B64,
    findCiphertextPaths,
    isCiphertextEnvelope,
} from '@/lib/security/ciphertext-egress';
import { encryptWithKey } from '@/lib/security/encryption';

const realEnvelope = (plaintext: string) =>
    encryptWithKey(crypto.randomBytes(32), plaintext);

describe('the envelope matcher is tied to its PRODUCER', () => {
    /**
     * The load-bearing test. A matcher written from a comment about the format
     * goes stale the moment the format moves and nothing fails — so this
     * asserts against what `encryptWithKey` actually returns, for plaintexts
     * spanning the interesting range.
     */
    it.each([
        ['empty', ''],
        ['one char', 'x'],
        ['a Bulgarian note', 'Северният ъгъл се подмокря след дъжд.'],
        ['long', 'я'.repeat(4000)],
    ])('matches a REAL encryptWithKey output (%s)', (_label, plaintext) => {
        const env = realEnvelope(plaintext);
        expect(env.startsWith('v2:')).toBe(true);
        expect(isCiphertextEnvelope(env)).toBe(true);
    });

    it('the length floor is the shortest the producer can emit, not a guess', () => {
        // An empty plaintext is iv(12) + 0 + tag(16) = 28 bytes.
        const shortest = realEnvelope('');
        const b64 = shortest.slice('v2:'.length);
        expect(b64.length).toBe(ENVELOPE_MIN_B64);
        // One character shorter must NOT match, or the floor is decorative.
        expect(isCiphertextEnvelope(`v2:${b64.slice(0, -1)}`)).toBe(false);
    });
});

describe('precision — what must NOT be flagged', () => {
    /**
     * Every one of these is a string a person could plausibly store, and
     * flagging any of them would mean a log line (today) or a redaction (if
     * this ever became a gate) against real content.
     */
    it.each([
        ['a note that happens to start v2:', 'v2: план за пръскане утре'],
        ['a version label', 'v2:draft'],
        ['the bare prefix', 'v2:'],
        ['v1 bare', 'v1:'],
        ['an envelope-looking string mid-sentence', `see v2:${'A'.repeat(40)}`],
        ['base64 with no prefix', 'A'.repeat(60)],
        ['url-safe base64, which we never emit', `v2:${'-_'.repeat(30)}`],
        ['a plausible version string', 'v12:something'],
        ['a different scheme', 'v3:' + 'A'.repeat(40)],
        ['whitespace inside', `v2:${'A'.repeat(20)} ${'A'.repeat(20)}`],
        ['a Cyrillic body', `v2:${'я'.repeat(60)}`],
    ])('does not flag %s', (_label, value) => {
        expect(isCiphertextEnvelope(value)).toBe(false);
    });

    it('is not fooled by type', () => {
        for (const v of [null, undefined, 42, {}, [], true]) {
            expect(isCiphertextEnvelope(v)).toBe(false);
        }
    });
});

describe('paths, never values', () => {
    it('names the field that shipped ciphertext', () => {
        const env = realEnvelope('секретно');
        const { paths } = findCiphertextPaths({
            rows: [
                { id: 'a', body: 'fine' },
                { id: 'b', body: env },
            ],
            meta: { nextCursor: null },
        });
        expect(paths).toEqual(['rows[1].body']);
    });

    it('finds several, at depth', () => {
        const env = realEnvelope('x');
        const { paths } = findCiphertextPaths({ a: { b: { c: env } }, d: [[env]] });
        expect(paths.sort()).toEqual(['a.b.c', 'd[0][0]']);
    });

    it('returns NOTHING for a clean payload — the negative control', () => {
        const scan = findCiphertextPaths({
            rows: [{ body: 'Северният ъгъл се подмокря' }],
            note: 'v2: план',
        });
        expect(scan.paths).toEqual([]);
        // And it got to look at all of it — an empty result from a TRUNCATED
        // walk would be the detector being blind, not the payload being clean.
        expect(scan.truncated).toBe(false);
    });

    it('reports a bare string payload as $', () => {
        expect(findCiphertextPaths(realEnvelope('x')).paths).toEqual(['$']);
    });

    it('caps the number of paths so a bad payload cannot be the slow part', () => {
        const env = realEnvelope('x');
        const many = Array.from({ length: 500 }, () => ({ body: env }));
        const { paths } = findCiphertextPaths(many);
        expect(paths.length).toBe(10);
    });

    /**
     * The DEPTH cap's own test. Measured: with a cycle, the WeakSet and
     * MAX_DEPTH are redundant — removing either alone still passes, and only
     * removing BOTH fails. So the cyclic test below could not tell them apart,
     * and a guard no test distinguishes is indistinguishable from an
     * unnecessary one. This separates them: a DEEP ACYCLIC payload has no
     * repeated object for the WeakSet to catch, so only the depth cap saves
     * the stack.
     */
    it('survives a pathologically deep ACYCLIC payload', () => {
        let node: Record<string, unknown> = { body: 'leaf' };
        for (let i = 0; i < 20_000; i += 1) node = { nested: node };
        expect(() => findCiphertextPaths(node)).not.toThrow();
    });

    it('still finds an envelope at a normal nesting depth', () => {
        // The cap must not be so tight that it blinds the detector on real
        // payloads: a cursor-paginated list of rows with nested authors is
        // about six levels, nowhere near MAX_DEPTH.
        const env = realEnvelope('x');
        const payload = { data: { rows: [{ author: { profile: { bio: env } } }] } };
        expect(findCiphertextPaths(payload).paths).toEqual(['data.rows[0].author.profile.bio']);
    });

    /**
     * MAX_NODES' own test. Measured: removing that cap failed NOTHING, because
     * every other test either trips the path cap first or is small. A huge
     * CLEAN payload is the case it exists for — and the assertion is on
     * `truncated`, not on time, because a wall-clock bound would be flaky on a
     * loaded machine and would not say what happened.
     */
    it('reports TRUNCATED on a payload too large to finish', () => {
        const wide = Array.from({ length: 60_000 }, (_, i) => `row ${i}`);
        const scan = findCiphertextPaths(wide);
        expect(scan.paths).toEqual([]);
        // The important half: empty paths here does NOT mean clean.
        expect(scan.truncated).toBe(true);
    });

    it('survives a cyclic object rather than hanging', () => {
        // Not a contrived worry: a payload assembled by hand can carry one,
        // and a detector that hangs is worse than one that misses.
        const node: Record<string, unknown> = { body: 'fine' };
        node.self = node;
        expect(() => findCiphertextPaths(node)).not.toThrow();
    });
});

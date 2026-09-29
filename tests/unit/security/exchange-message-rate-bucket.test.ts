/**
 * The exchange-message cap is SHARED across a tenant's users — executed.
 *
 * #1161. The generic mutation tier keys on `(IP, userId)`, which bounds one
 * caller. That is the wrong shape here: the flood lands on the RECIPIENT's
 * notification bell, every sender is a legitimate member of the sending
 * tenant, and a tenant with ten users therefore gets ten budgets aimed at one
 * person.
 *
 * So the property under test is not "a limit exists" — it is that two
 * DIFFERENT users, on two DIFFERENT IPs, sending into the same thread, land
 * in the SAME bucket. A test that only checked one caller gets throttled
 * would pass against the old behaviour and prove nothing.
 *
 * Note what is deliberately NOT claimed here: this is not the email-fanout
 * threat that `EXCHANGE_INQUIRY_LIMIT` guards. `notifyOtherParty` builds its
 * email dedupe key ending in the UTC day, so the second message of a thread
 * sends no mail at all.
 */
import { buildRateLimitKey } from '@/lib/security/rate-limit-middleware';
import { EXCHANGE_MESSAGE_LIMIT } from '@/lib/security/rate-limit';
import { messageRateBucket } from '@/lib/security/exchange-message-bucket';
import type { NextRequest } from 'next/server';

/** A request carrying only what the bucket resolver reads: the path. */
function reqFor(pathname: string): NextRequest {
    return { nextUrl: { pathname } } as unknown as NextRequest;
}

describe('messageRateBucket — derived from the URL, never the database', () => {
    it('extracts the tenant and thread from the send path', () => {
        expect(messageRateBucket(reqFor('/api/t/acme/exchange/threads/th_123/messages'))).toBe(
            't:acme',
        );
    });

    it('tolerates a trailing slash', () => {
        expect(messageRateBucket(reqFor('/api/t/acme/exchange/threads/th_123/messages/'))).toBe(
            't:acme',
        );
    });

    it('EVERY thread of one tenant shares the budget — the whole point', () => {
        // A thread is per (listing, inquirer), so a per-thread cap would let
        // an abuser multiply budgets by writing on each of a seller's
        // listings — a ceiling chosen by the victim.
        const a = messageRateBucket(reqFor('/api/t/acme/exchange/threads/th_1/messages'));
        const b = messageRateBucket(reqFor('/api/t/acme/exchange/threads/th_2/messages'));
        expect(a).toBe(b);
    });

    it('two different TENANTS stay separate', () => {
        // Both parties write into the same thread. Pooling them would let a
        // spammer consume the budget their counterparty needs to reply,
        // turning a rate limit into a denial of service against the victim.
        expect(messageRateBucket(reqFor('/api/t/seller/exchange/threads/th_1/messages'))).not.toBe(
            messageRateBucket(reqFor('/api/t/buyer/exchange/threads/th_1/messages')),
        );
    });

    it('decodes percent-encoding, so one tenant cannot present as two buckets', () => {
        // Without decoding, `ac%6De` and `acme` are the same tenant and two
        // budgets — which is the exact split this whole change removes.
        expect(messageRateBucket(reqFor('/api/t/ac%6De/exchange/threads/th_1/messages'))).toBe(
            't:acme',
        );
    });

    it('returns null on a path it does not recognise', () => {
        // Degrades to the per-caller key. A resolver that invented a bucket
        // from an unexpected shape would pool unrelated traffic into one
        // budget, which throttles innocent callers.
        for (const p of [
            '/api/t/acme/exchange/threads/th_1',
            '/api/t/acme/exchange/listings/l_1/thread',
            '/api/t/acme/journal',
            '/messages',
        ]) {
            expect(messageRateBucket(reqFor(p))).toBeNull();
        }
    });

    it('is a positive control on the negative cases above', () => {
        // Every assertion in the previous test is an ABSENCE. If the regex
        // stopped matching anything at all they would all still pass, so this
        // pins that the resolver can still say yes.
        expect(messageRateBucket(reqFor('/api/t/x/exchange/threads/y/messages'))).not.toBeNull();
    });
});

describe('buildRateLimitKey — a bucket REPLACES the per-caller portion', () => {
    const BUCKET = 't:acme';

    it('two users on two IPs share ONE key when a bucket is given', () => {
        const a = buildRateLimitKey('exchange-message', '1.1.1.1', 'user-a', BUCKET);
        const b = buildRateLimitKey('exchange-message', '2.2.2.2', 'user-b', BUCKET);
        expect(a).toBe(b);
        expect(a).toBe('exchange-message:t:acme');
    });

    it('the IP and userId are ABSENT, not merely reordered', () => {
        // Appending the bucket would have kept the per-caller split and
        // changed nothing about the exposure. Assert the key does not carry
        // them at all.
        const key = buildRateLimitKey('exchange-message', '9.9.9.9', 'user-z', BUCKET);
        expect(key).not.toContain('9.9.9.9');
        expect(key).not.toContain('user-z');
        expect(key).not.toContain('ip:');
    });

    it('different buckets stay separate', () => {
        expect(buildRateLimitKey('exchange-message', '1.1.1.1', 'u', 't:seller')).not.toBe(
            buildRateLimitKey('exchange-message', '1.1.1.1', 'u', 't:buyer'),
        );
    });

    it('without a bucket the per-caller key is unchanged', () => {
        // The existing tiers must be bit-for-bit as before: this seam is
        // additive, and login/API-key budgets depend on the old shape.
        expect(buildRateLimitKey('login', '1.1.1.1', 'u1')).toBe('login:ip:1.1.1.1:u:u1');
        expect(buildRateLimitKey('login', '1.1.1.1', null)).toBe('login:ip:1.1.1.1:anon');
        expect(buildRateLimitKey('login', '1.1.1.1', 'u1', null)).toBe('login:ip:1.1.1.1:u:u1');
        expect(buildRateLimitKey('login', '1.1.1.1', 'u1', '')).toBe('login:ip:1.1.1.1:u:u1');
    });
});

describe('the preset', () => {
    it('is a per-minute window well under the generic tier', () => {
        expect(EXCHANGE_MESSAGE_LIMIT.windowMs).toBe(60_000);
        expect(EXCHANGE_MESSAGE_LIMIT.maxAttempts).toBe(60);
        // Deliberately the SAME number as API_MUTATION_LIMIT. The cut is not
        // in the number, it is in the KEY: 60 per (IP, userId) is 600 for a
        // ten-user tenant; 60 shared is 60. Asserting it is lower would be
        // asserting the wrong thing.
    });
});

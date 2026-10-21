/**
 * The coalesced market tick — #2123, the second half of P7.6 (#1995).
 *
 * The property worth protecting is the coalescing. A listing event is not
 * addressed to anybody — `listActiveListings` browses "across ALL tenants" —
 * so every connected client refetches on every tick. One tick per listing
 * would be a thundering refetch where a bounded one does the same job, because
 * a client refetches the list either way and never acts on WHICH listing
 * changed.
 */
let redis: { publish: jest.Mock; duplicate: jest.Mock } | null = null;
const warn = jest.fn();
const error = jest.fn();

jest.mock('@/lib/redis', () => ({
    __esModule: true,
    getRedis: () => redis,
}));
jest.mock('@/lib/observability/logger', () => ({
    __esModule: true,
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        error: (...a: unknown[]) => error(...a),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import {
    publishListingChange,
    subscribeToListings,
    COALESCE_WINDOW_MS,
    LISTING_CHANNEL,
    LISTING_TICK_ID,
    _resetListingBroadcastForTesting,
    _listingSubscriberCountForTesting,
} from '@/lib/realtime/listing-broadcast';

beforeEach(() => {
    _resetListingBroadcastForTesting();
    warn.mockClear();
    error.mockClear();
    redis = null;
});

afterEach(() => _resetListingBroadcastForTesting());

describe('coalescing', () => {
    it('publishes the first change immediately', () => {
        // A listing created in a quiet minute must not wait for a window.
        //
        // The clock here is deliberately SMALL. The first version of this
        // module used `0` for "never published" and compared `now - 0` as an
        // elapsed interval, which is only ever large enough because a real
        // `Date.now()` is — so under an injected clock the first tick of a
        // process was suppressed. A sentinel that works because one of its
        // inputs happens to be big is not a sentinel.
        expect(publishListingChange(1_000)).toBe(true);
    });

    it('suppresses a second change inside the window', () => {
        publishListingChange(1_000);

        expect(publishListingChange(1_000 + COALESCE_WINDOW_MS - 1)).toBe(false);
    });

    it('publishes again once the window has passed', () => {
        publishListingChange(1_000);

        expect(publishListingChange(1_000 + COALESCE_WINDOW_MS)).toBe(true);
    });

    it('a BURST of ten changes is one tick', () => {
        // The whole point. Ten listings created in a second would otherwise
        // cost every connected client ten refetches of the same page.
        const delivered = jest.fn();
        subscribeToListings(delivered);

        let published = 0;
        for (let i = 0; i < 10; i++) {
            if (publishListingChange(1_000 + i * 100)) published += 1;
        }

        expect(published).toBe(1);
        expect(delivered).toHaveBeenCalledTimes(1);
    });

    it('a slow trickle is one tick EACH — it is a coalescer, not a rate limit', () => {
        // The control for the burst case: suppressing a change that arrives
        // in a quiet window would make the market stop feeling live, which is
        // the point of the feature.
        const delivered = jest.fn();
        subscribeToListings(delivered);

        for (let i = 0; i < 3; i++) publishListingChange(1_000 + i * COALESCE_WINDOW_MS);

        expect(delivered).toHaveBeenCalledTimes(3);
    });
});

describe('delivery', () => {
    it('reaches every subscriber in the process', () => {
        const a = jest.fn();
        const b = jest.fn();
        subscribeToListings(a);
        subscribeToListings(b);

        publishListingChange(1_000);

        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('one throwing subscriber does not cost the others their tick', () => {
        // Same poison-pill posture as the notification bus: a Set iterates in
        // insertion order, so without the guard the OLDEST stream's failure
        // would abandon every newer one.
        const boom = jest.fn(() => {
            throw new Error('stream gone');
        });
        const after = jest.fn();
        subscribeToListings(boom);
        subscribeToListings(after);

        publishListingChange(1_000);

        expect(after).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('listings.listener_threw', expect.anything());
    });

    it('stops delivering to an unsubscribed stream', () => {
        const gone = jest.fn();
        const release = subscribeToListings(gone);
        release();

        publishListingChange(1_000);

        expect(gone).not.toHaveBeenCalled();
        expect(_listingSubscriberCountForTesting()).toBe(0);
    });

    it('unsubscribe is idempotent', () => {
        // A stream reaches cleanup from both an abort and a cancel (#1984), so
        // a second call must not disturb a channel another tab is using.
        const one = jest.fn();
        const release = subscribeToListings(one);
        subscribeToListings(jest.fn());

        release();
        release();

        expect(_listingSubscriberCountForTesting()).toBe(1);
    });

    it('delivers in-process when Redis is absent', () => {
        // A single-process deployment, and every test. The notification bus
        // makes the same choice for the same reason.
        const delivered = jest.fn();
        subscribeToListings(delivered);

        expect(publishListingChange(1_000)).toBe(true);
        expect(delivered).toHaveBeenCalledTimes(1);
    });
});

describe('with Redis', () => {
    beforeEach(() => {
        redis = {
            publish: jest.fn().mockResolvedValue(1),
            duplicate: jest.fn(() => ({
                subscribe: jest.fn().mockResolvedValue(undefined),
                unsubscribe: jest.fn().mockResolvedValue(undefined),
                on: jest.fn(),
                disconnect: jest.fn(),
            })),
        };
    });

    it('publishes to ONE global channel, not one per farm', () => {
        // There is no (farm, person) pair to address: the exchange browses
        // across all tenants, so a per-farm channel would need a registry of
        // which farms have listeners and would still not reach a browsing
        // client in a farm with none.
        publishListingChange(1_000);

        expect(redis!.publish).toHaveBeenCalledWith(LISTING_CHANNEL, '1');
        expect(LISTING_CHANNEL).not.toContain('{');
    });

    it('does not deliver locally when it published to Redis', () => {
        // Otherwise the publishing process delivers twice: once in memory and
        // once when Redis fans the message back to it.
        const delivered = jest.fn();
        subscribeToListings(delivered);

        publishListingChange(1_000);

        expect(redis!.publish).toHaveBeenCalledTimes(1);
        expect(delivered).not.toHaveBeenCalled();
    });

    it('survives a publish that rejects', () => {
        redis!.publish.mockRejectedValue(new Error('redis down'));

        // Never throws: the caller is a listing write, and a notification
        // failure must not cost the write that caused it.
        expect(() => publishListingChange(1_000)).not.toThrow();
    });
});

describe('the tick sentinel', () => {
    it('is a constant, so a consumer cannot mistake it for a row handle', () => {
        // A coalesced tick refers to no single row and spans farms, so naming
        // one of the several listings that moved would invite a client to
        // refetch that one and miss the rest.
        expect(LISTING_TICK_ID).toBe('listings');
        expect(LISTING_TICK_ID).not.toMatch(/^c[a-z0-9]{20,}$/);
    });
});

/**
 * The cap's own state is attacker-controlled, so most of this suite is about
 * the BOUND rather than the rate.
 *
 * The clock is injected, which is what makes every boundary here exact. A
 * time-dependent cap tested against the real clock can only be tested by
 * sleeping, and a test that sleeps is a test nobody runs at a boundary — so
 * the interesting cases get skipped and the cap is green about the middle of
 * its range.
 */
import { ImeiRateCap, BURST, REFILL_PER_SECOND, MAX_TRACKED } from '@/lib/machines/imei-rate-cap';

const T0 = 1_794_312_000_000;
const imei = (n: number) => String(100000000000000 + n);

describe('§1 the token bucket', () => {
    it('allows a full burst and then refuses', () => {
        const cap = new ImeiRateCap();
        for (let i = 0; i < BURST; i++) {
            expect(cap.take(imei(1), T0).allowed).toBe(true);
        }
        expect(cap.take(imei(1), T0).allowed).toBe(false);
    });

    it('refills continuously, so the rate holds ACROSS a boundary', () => {
        // A fixed window would allow the whole burst at the end of one window
        // and again at the start of the next — twice the intended rate at the
        // seam. This is the test that tells the two designs apart.
        const cap = new ImeiRateCap();
        for (let i = 0; i < BURST; i++) cap.take(imei(1), T0);
        expect(cap.take(imei(1), T0).allowed).toBe(false);

        // One token's worth of time: 1 / 0.5 = 2 seconds.
        const oneToken = 1000 / REFILL_PER_SECOND;
        expect(cap.take(imei(1), T0 + oneToken - 1).allowed).toBe(false);
        expect(cap.take(imei(1), T0 + oneToken).allowed).toBe(true);
        // …and only ONE token arrived, not a fresh window.
        expect(cap.take(imei(1), T0 + oneToken).allowed).toBe(false);
    });

    it('never refills past the burst ceiling', () => {
        const cap = new ImeiRateCap();
        cap.take(imei(1), T0);
        // A week of silence must not bank a week of tokens.
        const v = cap.take(imei(1), T0 + 7 * 24 * 3600 * 1000);
        expect(v.remaining).toBeLessThanOrEqual(BURST);
        let allowed = 0;
        for (let i = 0; i < BURST * 3; i++) {
            if (cap.take(imei(1), T0 + 7 * 24 * 3600 * 1000).allowed) allowed++;
        }
        expect(allowed).toBe(BURST - 1);
    });

    it('survives a clock that goes BACKWARDS without tightening', () => {
        // NTP correction or a container clock jump. A negative elapsed time
        // would subtract tokens, silently making the cap stricter than
        // configured — and the symptom would be a real device refused with
        // nothing in the logs about time.
        const cap = new ImeiRateCap();
        const first = cap.take(imei(1), T0);
        const back = cap.take(imei(1), T0 - 60_000);
        expect(back.allowed).toBe(true);
        expect(back.remaining).toBeLessThanOrEqual(first.remaining);
        expect(back.remaining).toBeGreaterThanOrEqual(0);
    });

    it('keeps buckets independent — one device cannot spend another_s allowance', () => {
        const cap = new ImeiRateCap();
        for (let i = 0; i < BURST; i++) cap.take(imei(1), T0);
        expect(cap.take(imei(1), T0).allowed).toBe(false);
        expect(cap.take(imei(2), T0).allowed).toBe(true);
    });
});

describe('§2 the BOUND — the reason this class exists', () => {
    it('never holds more than maxTracked buckets under a flood of invented IMEIs', () => {
        // The defect this prevents: `Map<imei, count>` on a public port with
        // no authentication, where the KEY is attacker-supplied. 50x the cap
        // of distinct IMEIs must not grow the map past the cap.
        const cap = new ImeiRateCap({ maxTracked: 64 });
        for (let i = 0; i < 64 * 50; i++) {
            cap.take(imei(i), T0 + i);
        }
        expect(cap.size).toBe(64);
        expect(cap.size).toBeLessThanOrEqual(64);
    });

    it('reports when it evicted, so the listener can log a flood', () => {
        const cap = new ImeiRateCap({ maxTracked: 2 });
        expect(cap.take(imei(1), T0).evicted).toBe(false);
        expect(cap.take(imei(2), T0 + 1).evicted).toBe(false);
        // Third distinct IMEI must displace one.
        expect(cap.take(imei(3), T0 + 2).evicted).toBe(true);
        expect(cap.size).toBe(2);
    });

    it('evicts the least-recently-SEEN, not the most-throttled', () => {
        // Evicting the most-throttled bucket is what an attacker wants: it
        // makes the cap forget the device it is busy limiting. So a throttled
        // but ACTIVE device must survive while an idle one is dropped.
        const cap = new ImeiRateCap({ maxTracked: 2 });
        // imei(1) is idle after T0; imei(2) is hammered and throttled.
        cap.take(imei(1), T0);
        for (let i = 0; i < BURST + 5; i++) cap.take(imei(2), T0 + 1000 + i);
        expect(cap.take(imei(2), T0 + 2000).allowed).toBe(false); // throttled

        // A third IMEI arrives: the IDLE one must go, not the throttled one.
        cap.take(imei(3), T0 + 3000);
        // imei(2) is still known and still throttled — it was not forgotten.
        expect(cap.take(imei(2), T0 + 3000).allowed).toBe(false);
        // imei(1) was evicted, so it starts fresh.
        expect(cap.take(imei(1), T0 + 3000).allowed).toBe(true);
    });

    it('an eviction gives the real device MORE allowance, never less', () => {
        // The accepted harm, asserted so it stays the accepted one: a flood
        // can evict a real device's bucket, which RESETS its allowance. That is
        // strictly better for the device than being refused, and is why LRU
        // eviction is tolerable on an unauthenticated port.
        const cap = new ImeiRateCap({ maxTracked: 1 });
        for (let i = 0; i < BURST; i++) cap.take(imei(1), T0);
        expect(cap.take(imei(1), T0).allowed).toBe(false);
        cap.take(imei(999), T0 + 1); // flood evicts imei(1)
        expect(cap.take(imei(1), T0 + 2).allowed).toBe(true);
    });

    it('refuses rather than growing when nothing can be evicted', () => {
        // maxTracked 0 is degenerate and the safe direction is refusal, not
        // an unbounded map. A cap that grows under pressure is not a cap.
        const cap = new ImeiRateCap({ maxTracked: 0 });
        const v = cap.take(imei(1), T0);
        expect(v.allowed).toBe(false);
        expect(cap.size).toBe(0);
    });
});

describe('§3 the shipped constants are the ones the docblock argues for', () => {
    it('BURST is ten times the documented 30-second cadence', () => {
        // A tracker at 30 s sends 2 records a minute; the burst absorbs a
        // replayed backlog after a GSM outage, which is normal and expected.
        expect(BURST).toBe(20);
        expect(BURST / 2).toBe(10);
    });

    it('the sustained rate is 30 records a minute', () => {
        expect(REFILL_PER_SECOND * 60).toBe(30);
    });

    it('MAX_TRACKED is a real ceiling, not a sentinel', () => {
        expect(MAX_TRACKED).toBeGreaterThan(0);
        expect(Number.isFinite(MAX_TRACKED)).toBe(true);
    });

    it('a device at the documented cadence is NEVER throttled over an hour', () => {
        // The control that makes the numbers above mean something: the cap
        // must not refuse the traffic it was sized for. An hour at 30 s is
        // 120 records.
        const cap = new ImeiRateCap();
        let refused = 0;
        for (let i = 0; i < 120; i++) {
            if (!cap.take(imei(1), T0 + i * 30_000).allowed) refused++;
        }
        expect(refused).toBe(0);
    });

    it('a device at 1 Hz IS throttled — so the cap is not vacuous', () => {
        // The other direction. Without this, a cap of Infinity passes the
        // test above.
        const cap = new ImeiRateCap();
        let refused = 0;
        for (let i = 0; i < 120; i++) {
            if (!cap.take(imei(1), T0 + i * 1000).allowed) refused++;
        }
        expect(refused).toBeGreaterThan(0);
    });
});

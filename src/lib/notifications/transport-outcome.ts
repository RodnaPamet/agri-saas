/**
 * What one push transport actually did — #2171.
 *
 * ## Why a return value, when the callers already had a try/catch
 *
 * `push-send` and `push-summary` were written as though the transports throw:
 * a `try` around the send, `delivered += 1` after it, a `catch` that collects
 * the message. Neither transport has ever thrown. `sendApnsToUser` catches
 * per device (`deliver()` returns `'sent' | 'gone' | 'failed'` and the result
 * was discarded), catches its device read, and returns on an unconfigured
 * transport; `sendWebPushToUser` has the same shape. Both return
 * `Promise<void>`.
 *
 * So `delivered` counted TRANSPORT FUNCTIONS THAT RETURNED, three things
 * downstream were unreachable, and production proved it: two
 * `apns.send_threw` on 2026-10-21 against **zero** `push.transport_failed`,
 * with the job reporting success and never spending its `attempts: 3`.
 *
 * Communicating by exception was the wrong shape for a best-effort sender
 * addressing several devices, because "it failed" is not one bit — two devices
 * can give two different answers. So the transports report instead.
 *
 * ## `retryable` is the only failure count, and that is deliberate
 *
 * A retry is worth something for a connection that broke and worth nothing for
 * a device that is gone. So the counts answer exactly the two questions the
 * callers ask — "did anything arrive" and "is another attempt worth making" —
 * and nothing else. Dead tokens (APNs `410`, Web Push `404`/`410`) are pruned
 * and counted in NEITHER field: they are not deliveries, and retrying them is
 * how a dead device becomes a permanent failing send.
 *
 * Blocked endpoints are the same case for the same reason — the SSRF gate's
 * verdict does not change on a second attempt — and a row that registered
 * before it reported an APNs environment is too: what fixes it is the device
 * re-registering, not us asking again.
 */
export interface TransportOutcome {
    /** Devices the push service ACCEPTED. `> 0` is what "delivered" means. */
    sent: number;
    /**
     * Failures another attempt could plausibly fix — a broken connection, a
     * provider-token mint that failed, a device read that threw.
     *
     * Counted per device where the failure was per device. A transport that
     * failed before addressing any device reports `1`: one failure, which is
     * what happened, rather than a device count it never learned.
     */
    retryable: number;
}

/** Nothing to do, and nothing wrong — an unconfigured or device-less transport. */
export function noSend(): TransportOutcome {
    return { sent: 0, retryable: 0 };
}

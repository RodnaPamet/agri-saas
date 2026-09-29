import type { NextRequest } from 'next/server';

/**
 * The rate-limit bucket for one tenant's outbound exchange messages.
 *
 * Keyed on the SENDING TENANT ALONE — deliberately not on the thread.
 *
 * Per-thread was the first design and it is wrong, for a reason worth keeping
 * because it is not obvious: a thread is per (listing, inquirer), so the
 * number of budgets an abuser gets is chosen by the VICTIM. A seller with ten
 * listings can be written to in ten threads, and a per-thread cap of 30
 * therefore permits 300 a minute at one bell — half the exposure it was meant
 * to remove rather than a tenth of it. A cap whose ceiling scales with the
 * target's own catalogue is not a cap.
 *
 * Tenant-wide bounds the total regardless of how the traffic is spread.
 *
 * What that costs, stated rather than hidden: a tenant negotiating several
 * deals at once shares ONE budget across all of them. At 60/min that is a
 * message a second, sustained, across an entire organisation — ample for
 * people typing, and the constant is one line to raise if a real trader ever
 * feels it.
 *
 * Lives here rather than beside the route because an App Router `route.ts`
 * may only export the names Next permits. `tests/guards/app-router-module-
 * exports.test.ts` caught the extra export, and its reason is the useful
 * part: Next's generated types reject it with TS2344 **only after a build**,
 * so the Typecheck job cannot see it.
 *
 * Derived from the PATH, deliberately. The resolver runs before the handler —
 * that is the whole point of a rate limit — so anything it reads from the
 * database is work a caller can compel for free, inside the check meant to
 * stop them compelling work. That is also why the bucket is not
 * (sender, recipient), which would be the tightest match to the harm: the
 * recipient is only knowable by loading the thread.
 *
 * Returns null on a shape it does not recognise, which degrades to the
 * per-caller key rather than to no limit at all, and never pools unrelated
 * paths into one budget (which would throttle innocent callers).
 *
 * See #1161.
 */
export function messageRateBucket(req: NextRequest): string | null {
    // /api/t/<tenantSlug>/exchange/threads/<threadId>/messages
    const m = req.nextUrl.pathname.match(
        /\/api\/t\/([^/]+)\/exchange\/threads\/[^/]+\/messages\/?$/,
    );
    if (!m) return null;
    // Decoded, so one tenant cannot present as two buckets via encoding.
    return `t:${decodeURIComponent(m[1])}`;
}

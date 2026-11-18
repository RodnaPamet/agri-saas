/**
 * A person id taken from a request body must name an ACTIVE member of the
 * caller's farm (#3208).
 *
 * Task assignees, asset / location / evidence owners and reviewers are all
 * `*UserId` strings the client supplies. Stored unchecked, two things go
 * wrong at once: the write's response includes the referenced person's name
 * and e-mail (the repositories `include` the user relation), and the assign
 * paths e-mail that person. User ids are exposed on purpose elsewhere — a
 * channel author, an exchange counterparty — so an EDITOR of one farm could
 * name anybody on the platform and read their contact details back, while
 * the person received mail from a farm they have nothing to do with.
 *
 * One helper, so the rule cannot drift between call sites. It answers
 * `TARGET_USER_NOT_IN_TENANT` (404, the same answer for "no such person" and
 * "a person outside this farm", so it is not an oracle for user ids) and
 * runs on the caller's transaction: no second pool connection inside an open
 * one, which is #1191's deadlock.
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';
import { codedNotFound } from '@/lib/errors/types';

export async function assertActiveMembers(
    db: PrismaTx,
    ctx: RequestContext,
    ...userIds: Array<string | null | undefined>
): Promise<void> {
    const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return;
    const found = await db.tenantMembership.count({
        where: { tenantId: ctx.tenantId, userId: { in: ids }, status: 'ACTIVE' },
    });
    if (found !== ids.length) {
        throw codedNotFound('TARGET_USER_NOT_IN_TENANT', 'That person is not a member of this farm.');
    }
}

/**
 * Assigning work to yourself notifies nobody (#1755).
 *
 * ## Why this was the DEFAULT experience, not an edge case
 *
 * `enqueueTaskAssignedNotification` looked the assignee up and mailed them
 * with no comparison against `ctx.userId`, and the bell sibling did the same.
 * A farm is mostly one or two people, so the owner creating their own work is
 * the normal case — the mail named the same person as assignee and assigner,
 * and the bell appeared on the screen they were already looking at, one action
 * after they caused it.
 *
 * The cost is to the channel rather than to the inbox: `TASK_ASSIGNED` exists
 * so an operator learns about work they did NOT know about. A copy for work
 * they just typed trains people to ignore the ones that matter.
 *
 * ## The record is NOT suppressed, and that is asserted
 *
 * #1755 raised the counter-argument that suppressing the mail leaves a hole in
 * the record of "who was told what". It largely does not: `assignTask` writes
 * a `TASK_ASSIGNED` audit entry through `logEvent` INSIDE the transaction,
 * carrying `metadata.assigneeUserId`, and the guards do not touch it. The last
 * case here pins that, because it is the half of the argument that would make
 * this change wrong if it were false.
 *
 * What IS dropped is the separate record that a notification was sent — and
 * for a self-assignment, "was the assignee told?" has an answer that needs no
 * row: they did it themselves.
 */
const runInTenantContext = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...a: unknown[]) => runInTenantContext(...a),
    runInUserContext: jest.fn(),
    afterCommit: jest.fn(),
}));

const assign = jest.fn();
jest.mock('@/app-layer/repositories/WorkItemRepository', () => ({
    WorkItemRepository: { assign: (...a: unknown[]) => assign(...a) },
}));

const enqueueEmail = jest.fn();
jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: (...a: unknown[]) => enqueueEmail(...a),
}));

const createAssignmentNotification = jest.fn();
jest.mock('@/app-layer/notifications/assignment', () => ({
    createAssignmentNotification: (...a: unknown[]) => createAssignmentNotification(...a),
}));

const sendWebPushToUser = jest.fn();
const sendApnsToUser = jest.fn();
jest.mock('@/lib/notifications/web-push', () => ({
    sendWebPushToUser: (...a: unknown[]) => sendWebPushToUser(...a),
}));
// #1764 step 3 — the SECOND push sink. Mocked here for the same reason the
// web one is: the silence guarantee below has to cover every sink, and a
// transport added without extending it would leave the guarantee half true.
jest.mock('@/lib/notifications/apns', () => ({
    sendApnsToUser: (...a: unknown[]) => sendApnsToUser(...a),
}));

const logEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => logEvent(...a),
}));

// `@/lib/cache/list-cache`, measured — my first version invented
// `@/app-layer/usecases/cache-bust`, which jest refused outright rather than
// silently passing. A `{ virtual: true }` mock of a path that does not exist
// is the quieter version of the same mistake.
jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));

jest.mock('@/app-layer/policies/task.policies', () => ({
    assertCanWriteTasks: jest.fn(),
    assertCanReadTasks: jest.fn(),
    assertCanCommentOnTasks: jest.fn(),
    // #2169. A PARTIAL mock of a module throws on a new export the moment
    // the code under test calls it, and the error names the call site
    // rather than the mock — so every suite that mocks this module lists
    // every export, whether or not it exercises this one.
    assertCanEditTask: jest.fn(),
    // #2187 — the delete half of the same rule. Listed for the reason
    // above: a partial mock throws on a new export at the CALL site.
    assertCanDeleteTask: jest.fn(),
    assertCanDeleteTasks: jest.fn(),
}));

import { assignTask } from '@/app-layer/usecases/task';
import { makeRequestContext } from '../helpers/make-context';

/** `makeRequestContext` signs in as `user-1`. */
const ME = 'user-1';
const SOMEONE_ELSE = 'user-2';

/** A `user.findUnique` that would happily return an address if asked. */
function txWithUsers() {
    return {
        user: {
            findUnique: jest.fn()
                .mockResolvedValue({ email: 'a@b.test', name: 'A', uiLanguage: 'bg' }),
        },
    };
}

function resultFor(assigneeUserId: string) {
    return {
        id: 't1',
        tenantId: 'tenant-1',
        title: 'Пръскане',
        key: 'T-1',
        assigneeUserId,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    runInTenantContext.mockImplementation(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn(txWithUsers()));
    createAssignmentNotification.mockResolvedValue({ status: 'created', notification: null });
});

describe('assigning to SOMEONE ELSE still notifies — the control', () => {
    it('sends the email and rings the bell', async () => {
        assign.mockResolvedValue(resultFor(SOMEONE_ELSE));

        await assignTask(makeRequestContext('EDITOR'), 't1', SOMEONE_ELSE);

        // Without this, a guard that suppressed EVERY assignment would satisfy
        // every case below while deleting the feature.
        expect(enqueueEmail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'TASK_ASSIGNED' }),
        );
        expect(createAssignmentNotification).toHaveBeenCalled();
    });
});

describe('assigning to YOURSELF notifies nobody', () => {
    beforeEach(() => {
        assign.mockResolvedValue(resultFor(ME));
    });

    it('sends no email', async () => {
        await assignTask(makeRequestContext('EDITOR'), 't1', ME);

        expect(enqueueEmail).not.toHaveBeenCalled();
    });

    it('rings no bell', async () => {
        await assignTask(makeRequestContext('EDITOR'), 't1', ME);

        expect(createAssignmentNotification).not.toHaveBeenCalled();
    });

    it('sends no push on EITHER transport', async () => {
        // The bell guard returns before the pushes, so this follows from it —
        // asserted anyway because each push is a SEPARATE sink and a future
        // refactor could move one above the guard. A notification nobody
        // needed is worse on a lock screen than in a list.
        //
        // "On a lock screen" is now literal: #1764 step 3 added an APNs sink
        // beside the web one, so this case covers both. Checking one of two
        // would be a guarantee that reads as complete and holds for half the
        // devices — and the half it would miss is the phone, which is the one
        // with the lock screen.
        await assignTask(makeRequestContext('EDITOR'), 't1', ME);

        expect(sendWebPushToUser).not.toHaveBeenCalled();
        expect(sendApnsToUser).not.toHaveBeenCalled();
    });

    it('does not even look the recipient up', async () => {
        // The guard is at the TOP of the helper, so a self-assignment costs no
        // query. Not the point of the change, but it pins the guard's
        // POSITION: moved below the lookup, the suppression would still work
        // and this would fail.
        const tx = txWithUsers();
        runInTenantContext.mockImplementation(async (_c: unknown, fn: (db: unknown) => unknown) => fn(tx));

        await assignTask(makeRequestContext('EDITOR'), 't1', ME);

        expect(tx.user.findUnique).not.toHaveBeenCalled();
    });
});

describe('the AUDIT record survives the suppression', () => {
    it('writes TASK_ASSIGNED with the assignee, even for a self-assignment', async () => {
        // THE case that makes this change defensible. #1755's counter-argument
        // was that suppressing the mail holes the record of who was told what.
        // The audit entry is written inside the transaction and is untouched,
        // so who assigned what to whom is still recorded — only the
        // notification-sent row goes.
        assign.mockResolvedValue(resultFor(ME));

        await assignTask(makeRequestContext('EDITOR'), 't1', ME);

        expect(logEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'TASK_ASSIGNED',
                entityId: 't1',
                metadata: { assigneeUserId: ME },
            }),
        );
    });
});

/**
 * An optimistic write that fails must be ROLLED BACK before the error is shown.
 *
 * Measured on an iPhone in airplane mode, 2026-09-11. `commitStatus` in the
 * farm-task detail wrote the new status into the SWR cache first, called the
 * server second, and — on failure — showed an error while LEAVING the
 * optimistic value on screen. The revalidate in `finally` could not repair it
 * either: offline that fetch fails too, so SWR keeps what it has.
 *
 * The operator finished spraying, tapped "Mark done", typed the resolution note
 * БАБХ requires, and was shown RESOLVED for a compliance record that never left
 * the phone. Nothing queued it; that write does not go through the outbox.
 *
 * WHAT THIS TEST IS, HONESTLY: a STRUCTURAL guard, not a behavioural one. It
 * reads the source. A behavioural test would have to render
 * FarmTaskDetailClient, and the repo's existing optimistic-rollback tests
 * (tests/rendered/tasks-bulk-mutation.test.tsx) deliberately mirror the hook
 * wiring in a harness instead of mounting the component — which pins the
 * CONTRACT but would NOT have caught this defect, because the defect was the
 * component failing to follow the contract. So a harness test is the wrong
 * instrument here, and this is the honest second-best until a render test
 * exists. Tracked separately.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const FILE = 'src/app/t/[tenantSlug]/(app)/farm-tasks/[taskId]/FarmTaskDetailClient.tsx';
const SRC = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

/** A named handler's body, from its declaration to the closing of `finally`. */
function handlerBody(decl: string): string {
    const start = SRC.indexOf(decl);
    expect(start).toBeGreaterThan(-1); // positive control: the function still exists
    const end = SRC.indexOf('\n    };', start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
}
const commitStatusBody = () => handlerBody('const commitStatus = async (');
const handleAssignBody = () => handlerBody('const handleAssign = async (');

describe('a failed status change must not leave the optimistic value on screen', () => {
    it('captures the previous status BEFORE the optimistic write', () => {
        const body = commitStatusBody();
        const capture = body.indexOf('previousStatus');
        const optimistic = body.indexOf('{ revalidate: false }');
        expect(capture).toBeGreaterThan(-1);
        expect(optimistic).toBeGreaterThan(-1);
        // Order matters: capturing after the optimistic write records the NEW
        // value and the rollback becomes a no-op that looks like a rollback.
        expect(capture).toBeLessThan(optimistic);
    });

    it('restores it inside the catch block', () => {
        const body = commitStatusBody();
        const cat = body.indexOf('} catch');
        expect(cat).toBeGreaterThan(-1);
        const afterCatch = body.slice(cat);
        expect(afterCatch).toContain('status: previousStatus');
        // And it must happen before the message is set, so what the operator
        // reads and what they see agree.
        expect(afterCatch.indexOf('status: previousStatus')).toBeLessThan(
            afterCatch.indexOf('setStatusError('),
        );
    });

    it('revalidates only after a COMMITTED write', () => {
        const body = commitStatusBody();
        const fin = body.indexOf('} finally');
        expect(fin).toBeGreaterThan(-1);
        const afterFinally = body.slice(fin);
        // A bare `await taskQuery.mutate()` here rejects offline, and the
        // quick-action caller invokes commitStatus with `void`, so that was an
        // unhandled rejection thrown out of a finally — which also discarded
        // the catch block's rollback.
        expect(afterFinally).toMatch(/if \(committed\)\s*await taskQuery\.mutate\(\)/);
    });

    it('sends the status through the typed client, not a bare fetch', () => {
        // A bare fetch bypasses api-client's fetchOrThrow, so the operator gets
        // WebKit's raw "Load failed" instead of copy about having no signal.
        const body = commitStatusBody();
        expect(body).toContain('apiPost(');
        expect(body).not.toMatch(/await fetch\(/);
        // isOfflineError, NOT `instanceof ApiClientError && code === ...`.
        // instanceof compares class identity, so a module duplicated across
        // bundle chunks makes the branch silently take the wrong arm and the
        // operator reads the English default instead of translated copy.
        expect(body).toContain('isOfflineError(');
        expect(body).not.toContain('instanceof ApiClientError');
    });
});

describe('a failed ASSIGN must not leave the task showing a new assignee', () => {
    // handleAssign was worse than commitStatus: NO catch at all, and it never
    // checked res.ok. The optimistic write landed, the request failed, the
    // revalidate in `finally` failed too, and SWR kept the optimistic value —
    // so the task showed as reassigned to somebody who was never told. Silent
    // in BOTH the offline and the server-error case, and wired bare to onClick
    // so the rejection went unhandled.
    it('has a catch block at all', () => {
        expect(handleAssignBody()).toContain('} catch');
    });

    it('captures the previous assignee before the optimistic write', () => {
        const body = handleAssignBody();
        expect(body.indexOf('previousAssignee')).toBeLessThan(
            body.indexOf('{ revalidate: false }'),
        );
    });

    it('restores it and tells the operator', () => {
        const after = handleAssignBody().slice(handleAssignBody().indexOf('} catch'));
        expect(after).toContain('assigneeUserId: previousAssignee');
        expect(after).toContain('setAssignError(');
    });

    it('goes through the typed client and revalidates only when committed', () => {
        const body = handleAssignBody();
        expect(body).toContain('apiPost(');
        expect(body).not.toMatch(/await fetch\(/);
        expect(body).toMatch(/if \(committed\)\s*await taskQuery\.mutate\(\)/);
    });
});

/**
 * The pending-invite list must not carry the acceptance token (#1450).
 *
 * ## What was wrong
 *
 * `listPendingInvites` used `findMany` with an `include` and no `select`. A
 * bare `findMany` returns every scalar, and one of `TenantInvite`'s scalars is
 * `token` — the bearer credential `/invite/[token]` accepts, valid until
 * `expiresAt`. The route then does `jsonResponse(invites)` with no mapping, so
 * `GET /admin/invites` shipped every pending invite's live acceptance
 * credential.
 *
 * Not an escalation, and the test should not pretend otherwise:
 * `admin.members` is OWNER/ADMIN only, and such a caller can already create an
 * invite at any role and read its `url`. What it cost was blast radius — an
 * XSS on the admin page, a HAR attached to a support ticket, a screenshot of a
 * network tab, each carrying N live credentials for seven days rather than
 * none.
 *
 * ## Why this asserts the SELECT and not just the result
 *
 * Asserting "the returned rows have no `token` key" passes against a mock that
 * never had one, which is every mock anyone would write. The thing that
 * actually controls the field list is the argument handed to Prisma, so that
 * is what is asserted — and specifically that `select` is PRESENT and `include`
 * is absent.
 *
 * That distinction is the whole guard. Switching `select` back to `include`
 * reintroduces the leak while leaving the code looking correct and every
 * result-shaped assertion green, because the mock still returns whatever the
 * test told it to. A reviewer reading `include: { invitedBy: … }` sees a
 * relation being loaded, not a credential being exposed.
 */
import { makeRequestContext } from '../helpers/make-context';

const findMany = jest.fn();
const mockDb = { tenantInvite: { findMany } };

jest.mock('@/lib/db-context', () => ({
    __esModule: true,
    runInTenantContext: (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

import { listPendingInvites } from '@/app-layer/usecases/tenant-invites';

const ctx = makeRequestContext('OWNER');

/** The argument the usecase handed Prisma. */
function queryArg(): Record<string, unknown> {
    expect(findMany).toHaveBeenCalled();
    return findMany.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
});

describe('listPendingInvites does not expose the acceptance token', () => {
    it('uses an explicit select', async () => {
        await listPendingInvites(ctx);
        expect(queryArg().select).toBeDefined();
    });

    it('does NOT use `include` — that is what returns every scalar', async () => {
        // The mutation that matters. `include` loads the relation AND every
        // scalar column, `token` among them; `select` lists the fields. The two
        // look equally innocent at the call site.
        await listPendingInvites(ctx);
        expect(queryArg().include).toBeUndefined();
    });

    it('the selected fields do not include `token`', async () => {
        await listPendingInvites(ctx);
        const select = queryArg().select as Record<string, unknown>;
        expect(Object.keys(select)).not.toContain('token');
    });

    it('still selects everything the admin screen renders', async () => {
        // The other half: a select narrow enough to be safe and too narrow to
        // be useful would also pass the assertions above.
        await listPendingInvites(ctx);
        const select = queryArg().select as Record<string, unknown>;
        for (const field of ['id', 'email', 'role', 'expiresAt', 'createdAt', 'invitedBy']) {
            expect(Object.keys(select)).toContain(field);
        }
    });

    it('control: `token` really is a scalar a bare findMany would have returned', async () => {
        // Without this the whole file could pass against a model that never had
        // the field — asserting the absence of something that was never there.
        const { Prisma } = await import('@prisma/client');
        const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'TenantInvite');
        const scalars = model?.fields.filter((f) => f.kind === 'scalar').map((f) => f.name) ?? [];
        expect(scalars).toContain('token');
    });
});

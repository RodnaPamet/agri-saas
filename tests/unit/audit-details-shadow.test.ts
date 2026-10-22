/**
 * The shadow-parse reports, never refuses, and never logs a value — #2109.
 *
 * Enforcement breaks CALL SITES, and counting those statically failed twice:
 * 82, then 63 with a confirmed false positive, because a regex cannot read a
 * single-line literal reliably and 33 sites build their category dynamically
 * or spread `...details`. This is the instrument that counts what traffic
 * actually produces, including those 33.
 */
// The barrel is mocked PARTIALLY, exactly as the seven suites `audit.ts`'s own
// comment names do — `appendAuditEntry` is the only member the write path
// reaches. The logger is deliberately NOT mocked: these tests read what the
// real one was asked to emit.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn().mockResolvedValue({ id: 'a', entryHash: 'h', previousHash: null }),
}));

import { shadowParseAuditDetails } from '@/app-layer/events/audit-details-shadow';
import { logEvent } from '@/app-layer/events/audit';
import { appendAuditEntry } from '@/lib/audit';
import type { RequestContext } from '@/app-layer/types';
import { logger } from '@/lib/observability/logger';

type WarnFields = Record<string, unknown>;

function captureWarn() {
    return jest.spyOn(
        logger as unknown as { warn: (m: string, f?: WarnFields) => void },
        'warn',
    );
}
const mismatches = (spy: ReturnType<typeof captureWarn>) =>
    spy.mock.calls.filter((c) => c[0] === 'audit.details_not_canonical');

afterEach(() => jest.restoreAllMocks());

describe('shadowParseAuditDetails', () => {
    it('says nothing for a payload the canonical schema accepts', () => {
        const spy = captureWarn();
        shadowParseAuditDetails(
            { category: 'entity_lifecycle', entityName: 'Task', operation: 'created' },
            'CREATE',
            'Task',
        );
        expect(mismatches(spy)).toHaveLength(0);
    });

    it('reports one it would refuse, with the paths and the action', () => {
        const spy = captureWarn();
        shadowParseAuditDetails(
            { category: 'entity_lifecycle', entityName: 'Task', operation: 'upsert' },
            'UPSERT',
            'Task',
        );
        const hit = mismatches(spy);
        expect(hit).toHaveLength(1);
        const f = hit[0][1] as WarnFields;
        expect(f.issue).toBe(2109);
        expect(f.action).toBe('UPSERT');
        expect(f.entityType).toBe('Task');
        expect(f.category).toBe('entity_lifecycle');
        expect(f.issues).toEqual(['operation:invalid_value']);
    });

    it('logs NO value from the payload — the rule, asserted', () => {
        // `detailsJson` carries operator-authored text, and `TenantSchema`
        // declares an `ownerEmail`. Owner ruling: shapes only. This is the
        // case that keeps it true, including against zod's own `issue.message`,
        // which quotes the offending value for some codes.
        const spy = captureWarn();
        const operatorText = 'operator-wrote-this-and-it-must-not-be-logged';
        shadowParseAuditDetails(
            {
                category: 'tenant',
                name: operatorText,
                slug: operatorText,
                ownerUserId: 'u-1',
                ownerEmail: 'someone@example.test',
                unexpectedKey: operatorText,
            },
            'TENANT_CREATED',
            'Tenant',
        );
        const serialised = JSON.stringify(mismatches(spy));
        expect(serialised).not.toContain(operatorText);
        expect(serialised).not.toContain('example.test');
        // But the KEY NAME is there, because that is what makes it actionable.
        expect(serialised).toContain('unexpectedKey');
    });

    it('names the top-level keys, which is what `.strict()` rejects', () => {
        const spy = captureWarn();
        shadowParseAuditDetails(
            { category: 'status_change', entityName: 'X', toStatus: 'Y', bogus: 1 },
            'UPDATE',
            'Task',
        );
        expect((mismatches(spy)[0][1] as WarnFields).keys).toEqual([
            'bogus',
            'category',
            'entityName',
            'toStatus',
        ]);
    });

    it('ignores null and undefined rather than reporting them', () => {
        // Most audit entries carry no detailsJson at all; reporting those
        // would bury the real mismatches under the common case.
        const spy = captureWarn();
        shadowParseAuditDetails(null, 'A', 'Task');
        shadowParseAuditDetails(undefined, 'B', 'Task');
        expect(mismatches(spy)).toHaveLength(0);
    });

    it('reports a payload with no category at all', () => {
        const spy = captureWarn();
        shadowParseAuditDetails({ entityName: 'X' }, 'A', 'Task');
        expect((mismatches(spy)[0][1] as WarnFields).category).toBe('<none>');
    });

    it('never throws, whatever it is handed', () => {
        // It runs on the hot path of every audited write. A diagnostic that
        // throws would convert a reporting gap into a LOST AUDIT ROW, which is
        // the opposite trade.
        //
        // The FIRST input is the one that earns this test. `safeParse` does
        // not throw on malformed data — it returns a failure — so none of the
        // odd-but-inert values below reach the catch at all, and a version of
        // this test built only from those passed with the catch REMOVED
        // (measured: rethrowing left every assertion green). A throwing getter
        // does reach it: zod reads `category` for the discriminator, and
        // `safeParse` rethrows anything that is not a ZodError.
        const hostile = {
            get category(): string {
                throw new Error('a getter with side effects');
            },
        };
        const circular: Record<string, unknown> = { category: 'custom' };
        circular.self = circular;
        for (const input of [hostile, circular, 42, 'str', [], Symbol('x'), () => {}, new Map()]) {
            expect(() => shadowParseAuditDetails(input, 'A', 'Task')).not.toThrow();
        }
    });

    it('stays silent when it cannot read the payload at all', () => {
        // Having swallowed the throw, it must not then log a half-built line
        // claiming a mismatch it never actually determined.
        const spy = captureWarn();
        shadowParseAuditDetails(
            {
                get category(): string {
                    throw new Error('a getter with side effects');
                },
            },
            'A',
            'Task',
        );
        expect(mismatches(spy)).toHaveLength(0);
    });
});

describe('logEvent with the shadow wired in', () => {
    // The property the whole change rests on: it REPORTS, it does not refuse.
    // Tested at the wiring rather than on the function, because "refuses
    // nothing" is a statement about the call site — the function returns void
    // and `logEvent` ignores it, so only a throw could break a write.
    const ctx = { tenantId: 't1', userId: 'u1', requestId: 'r1' } as unknown as RequestContext;
    const appended = appendAuditEntry as jest.MockedFunction<typeof appendAuditEntry>;
    const db = {} as never;

    beforeEach(() => appended.mockClear());

    it('still writes the row when the payload is not canonical', async () => {
        const spy = captureWarn();
        await logEvent(db, ctx, {
            action: 'UPSERT',
            entityType: 'Task',
            entityId: 'task-1',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'upsert' },
        });
        expect(appended).toHaveBeenCalledTimes(1);
        // And the row keeps the payload the PERMISSIVE validator accepted —
        // the shadow must not filter, rewrite or drop a single key.
        expect(appended.mock.calls[0][0]).toMatchObject({
            action: 'UPSERT',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'upsert' },
        });
        expect(mismatches(spy)).toHaveLength(1);
    });

    it('writes and says nothing when the payload is canonical', async () => {
        const spy = captureWarn();
        await logEvent(db, ctx, {
            action: 'CREATE',
            entityType: 'Task',
            entityId: 'task-2',
            detailsJson: { category: 'entity_lifecycle', entityName: 'Task', operation: 'created' },
        });
        expect(appended).toHaveBeenCalledTimes(1);
        expect(mismatches(spy)).toHaveLength(0);
    });

    it('writes the common no-detailsJson entry untouched', async () => {
        const spy = captureWarn();
        await logEvent(db, ctx, { action: 'VIEW', entityType: 'Task', entityId: 'task-3' });
        expect(appended).toHaveBeenCalledTimes(1);
        expect(mismatches(spy)).toHaveLength(0);
    });
});

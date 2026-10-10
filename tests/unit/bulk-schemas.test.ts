import { BulkAssignSchema, BulkStatusSchema, BulkDueDateSchema } from '../../src/lib/schemas';

describe('Bulk Schemas', () => {
    describe('BulkAssignSchema', () => {
        it('validates valid assign payload', () => {
            const result = BulkAssignSchema.safeParse({ taskIds: ['id1', 'id2'], assigneeUserId: 'user1' });
            expect(result.success).toBe(true);
        });

        it('allows null assigneeUserId for unassign', () => {
            const result = BulkAssignSchema.safeParse({ taskIds: ['id1'], assigneeUserId: null });
            expect(result.success).toBe(true);
        });

        it('rejects empty taskIds', () => {
            const result = BulkAssignSchema.safeParse({ taskIds: [], assigneeUserId: null });
            expect(result.success).toBe(false);
        });

        it('rejects more than 100 taskIds', () => {
            const ids = Array.from({ length: 101 }, (_, i) => `id${i}`);
            const result = BulkAssignSchema.safeParse({ taskIds: ids, assigneeUserId: null });
            expect(result.success).toBe(false);
        });

        it('strips unknown fields', () => {
            const result = BulkAssignSchema.parse({ taskIds: ['id1'], assigneeUserId: null, extra: 'field' });
            expect(result).not.toHaveProperty('extra');
        });
    });

    describe('BulkStatusSchema', () => {
        it('validates valid status payload', () => {
            const result = BulkStatusSchema.safeParse({ taskIds: ['id1'], status: 'RESOLVED' });
            expect(result.success).toBe(true);
        });

        it('accepts optional resolution', () => {
            const result = BulkStatusSchema.safeParse({ taskIds: ['id1'], status: 'RESOLVED', resolution: 'Fixed' });
            expect(result.success).toBe(true);
        });

        it('rejects invalid status', () => {
            const result = BulkStatusSchema.safeParse({ taskIds: ['id1'], status: 'INVALID' });
            expect(result.success).toBe(false);
        });

        it('rejects empty taskIds', () => {
            const result = BulkStatusSchema.safeParse({ taskIds: [], status: 'OPEN' });
            expect(result.success).toBe(false);
        });
    });

    describe('BulkDueDateSchema', () => {
        it('validates valid due date payload', () => {
            const result = BulkDueDateSchema.safeParse({
                taskIds: ['id1'],
                dueAt: '2025-12-31T00:00:00.000Z',
            });
            expect(result.success).toBe(true);
        });

        it('refuses a bare day — the field declares format: date-time (#1443)', () => {
            // This fixture WAS `'2025-12-31'` and passed. It no longer does,
            // and that is the change: the bulk-due handler sends
            // `ymdToInstant(bulkValue)` now, so the server enforces the format
            // the spec publishes instead of accepting two shapes for one
            // field. Kept as an explicit rejection rather than just converted,
            // so the narrowing cannot be undone without this failing.
            expect(BulkDueDateSchema.safeParse({ taskIds: ['id1'], dueAt: '2025-12-31' }).success).toBe(
                false,
            );
        });

        it('allows null dueAt to clear due date', () => {
            const result = BulkDueDateSchema.safeParse({ taskIds: ['id1'], dueAt: null });
            expect(result.success).toBe(true);
        });

        it('rejects empty taskIds', () => {
            const result = BulkDueDateSchema.safeParse({ taskIds: [], dueAt: null });
            expect(result.success).toBe(false);
        });
    });
});

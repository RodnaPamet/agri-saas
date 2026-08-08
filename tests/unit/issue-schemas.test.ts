/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Issue Management - Zod Schema Validation Tests
 */
import {
    CreateIssueSchema,
    UpdateIssueSchema,
    SetIssueStatusSchema,
    AssignIssueSchema,
    AddIssueLinkSchema,
    AddIssueCommentSchema,
} from '@/lib/schemas';

describe('Issue Schemas', () => {
    describe('CreateIssueSchema', () => {
        it('accepts valid input', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Test Issue',
                type: 'INCIDENT',
                severity: 'HIGH',
                priority: 'P1',
            });
            expect(result.success).toBe(true);
        });

        it('requires title', () => {
            const result = CreateIssueSchema.safeParse({ type: 'INCIDENT' });
            expect(result.success).toBe(false);
        });

        it('defaults type to TASK when not provided', () => {
            const result = CreateIssueSchema.safeParse({ title: 'Test' });
            expect(result.success).toBe(true);
            if (result.success) expect(result.data.type).toBe('TASK');
        });

        it('rejects invalid type', () => {
            const result = CreateIssueSchema.safeParse({ title: 'Test', type: 'INVALID' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid severity', () => {
            const result = CreateIssueSchema.safeParse({ title: 'Test', type: 'TASK', severity: 'ULTRA' });
            expect(result.success).toBe(false);
        });

        it('rejects invalid priority', () => {
            const result = CreateIssueSchema.safeParse({ title: 'Test', type: 'TASK', priority: 'P9' });
            expect(result.success).toBe(false);
        });

        it('strips unknown fields', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Test',
                type: 'TASK',
                injectedField: 'hacked',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect((result.data as any).injectedField).toBeUndefined();
            }
        });

        it('accepts nullable description', () => {
            const result = CreateIssueSchema.safeParse({
                title: 'Test',
                type: 'TASK',
                description: null,
            });
            expect(result.success).toBe(true);
        });
    });

    describe('UpdateIssueSchema', () => {
        it('accepts partial updates', () => {
            const result = UpdateIssueSchema.safeParse({ title: 'Updated' });
            expect(result.success).toBe(true);
        });

        it('accepts empty body', () => {
            const result = UpdateIssueSchema.safeParse({});
            expect(result.success).toBe(true);
        });

        it('rejects invalid severity', () => {
            const result = UpdateIssueSchema.safeParse({ severity: 'INVALID' });
            expect(result.success).toBe(false);
        });

        it('strips unknown fields', () => {
            const result = UpdateIssueSchema.safeParse({ title: 'X', foo: 'bar' });
            expect(result.success).toBe(true);
            if (result.success) {
                expect((result.data as any).foo).toBeUndefined();
            }
        });
    });

    describe('SetIssueStatusSchema', () => {
        it('accepts valid status', () => {
            const result = SetIssueStatusSchema.safeParse({ status: 'RESOLVED', resolution: 'Fixed it' });
            expect(result.success).toBe(true);
        });

        it('requires status', () => {
            const result = SetIssueStatusSchema.safeParse({});
            expect(result.success).toBe(false);
        });

        it('rejects invalid status', () => {
            const result = SetIssueStatusSchema.safeParse({ status: 'DELETED' });
            expect(result.success).toBe(false);
        });

        it.each(['OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'CLOSED'])('accepts status %s', (status) => {
            const result = SetIssueStatusSchema.safeParse({ status });
            expect(result.success).toBe(true);
        });
    });

    describe('AssignIssueSchema', () => {
        it('accepts userId', () => {
            const result = AssignIssueSchema.safeParse({ assigneeUserId: 'user-1' });
            expect(result.success).toBe(true);
        });

        it('accepts null to unassign', () => {
            const result = AssignIssueSchema.safeParse({ assigneeUserId: null });
            expect(result.success).toBe(true);
        });

        it('requires assigneeUserId', () => {
            const result = AssignIssueSchema.safeParse({});
            expect(result.success).toBe(false);
        });
    });

    describe('AddIssueLinkSchema', () => {
        it('accepts valid link', () => {
            const result = AddIssueLinkSchema.safeParse({ entityType: 'CONTROL', entityId: 'ctrl-1' });
            expect(result.success).toBe(true);
        });

        it('rejects invalid entityType', () => {
            const result = AddIssueLinkSchema.safeParse({ entityType: 'UNKNOWN', entityId: '1' });
            expect(result.success).toBe(false);
        });

        it.each(['CONTROL', 'ASSET', 'EVIDENCE', 'FILE'])('accepts entityType %s', (entityType) => {
            const result = AddIssueLinkSchema.safeParse({ entityType, entityId: 'id-1' });
            expect(result.success).toBe(true);
        });

        it.each(['RELATES_TO', 'CAUSED_BY', 'MITIGATED_BY', 'EVIDENCE_FOR'])('accepts relation %s', (relation) => {
            const result = AddIssueLinkSchema.safeParse({ entityType: 'CONTROL', entityId: '1', relation });
            expect(result.success).toBe(true);
        });

        it('requires entityId to be non-empty', () => {
            const result = AddIssueLinkSchema.safeParse({ entityType: 'CONTROL', entityId: '' });
            expect(result.success).toBe(false);
        });
    });

    describe('AddIssueCommentSchema', () => {
        it('accepts valid body', () => {
            const result = AddIssueCommentSchema.safeParse({ body: 'This is a comment' });
            expect(result.success).toBe(true);
        });

        it('rejects empty body', () => {
            const result = AddIssueCommentSchema.safeParse({ body: '' });
            expect(result.success).toBe(false);
        });

        it('requires body', () => {
            const result = AddIssueCommentSchema.safeParse({});
            expect(result.success).toBe(false);
        });
    });
});

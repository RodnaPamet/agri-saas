/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/audit.ts
 *
 * Wave 3 of GAP-02. Audit lifecycle is the surface auditors actually
 * see — title / scope / criteria / auditors / auditees / departments
 * are encrypted at rest (Epic B) AND surface in PDFs + audit-pack
 * share links + JSON exports. A sanitiser regression here means
 * stored XSS in the very deliverable that compliance teams hand to
 * external auditors.
 *
 * Behaviours protected:
 *   1. assertCanWrite gate on create / update.
 *   2. Sanitisation of title (always) + scope/criteria/auditors/
 *      auditees/departments (when supplied) on create AND update.
 *   3. status='PLANNED' default on create.
 *   4. generateChecklist=true creates 10 standard items + up to 10
 *      control-derived items.
 *   5. updateAudit: notFound on missing audit; checklistUpdates
 *      sanitises notes per element (encrypted column).
 *   6. CREATE / UPDATE audit emit.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/repositories/AuditRepository', () => ({
    AuditRepository: {
        list: jest.fn(),
        getById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        createChecklistItem: jest.fn(),
        updateChecklistItem: jest.fn(),
    },
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string | null | undefined) => `SANITISED(${s})`),
}));

jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    createAudit,
    updateAudit,
} from '@/app-layer/usecases/audit';
import { runInTenantContext } from '@/lib/db-context';
import { AuditRepository } from '@/app-layer/repositories/AuditRepository';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockCreate = AuditRepository.create as jest.MockedFunction<typeof AuditRepository.create>;
const mockUpdate = AuditRepository.update as jest.MockedFunction<typeof AuditRepository.update>;
const mockCreateItem = AuditRepository.createChecklistItem as jest.MockedFunction<typeof AuditRepository.createChecklistItem>;
const mockUpdateItem = AuditRepository.updateChecklistItem as jest.MockedFunction<typeof AuditRepository.updateChecklistItem>;
const mockSanitize = sanitizePlainText as jest.MockedFunction<typeof sanitizePlainText>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
    mockSanitize.mockImplementation((s: string | null | undefined) => `SANITISED(${s})`);
    mockCreate.mockResolvedValue({ id: 'a1', title: 'SANITISED(Q4 audit)' } as never);
    mockUpdate.mockResolvedValue({ id: 'a1' } as never);
});

function fakeDbWithControls(controls: { id: string; name: string; code?: string }[] = []) {
    return {
        control: { findMany: jest.fn().mockResolvedValue(controls) },
    };
}

describe('createAudit', () => {
    it('rejects READER (canWrite gate)', async () => {
        await expect(
            createAudit(makeRequestContext('READER'), { title: 'Q4' }),
        ).rejects.toThrow();
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('rejects AUDITOR — auditors view but cannot create audits', async () => {
        await expect(
            createAudit(makeRequestContext('AUDITOR'), { title: 'Q4' }),
        ).rejects.toThrow();
    });

    it('sanitises title + every encrypted free-text field', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), {
            title: '<b>Q4</b>',
            scope: '<script>alert(1)</script>',
            criteria: 'criteria-text',
            auditors: 'Alice;Bob',
            auditees: 'Carol',
            departments: 'Eng;Ops',
        });

        const repoArgs = mockCreate.mock.calls[0][2];
        // Regression: a refactor that drops sanitiser wrappers around
        // these encrypted columns would persist raw HTML — surfacing
        // as stored XSS in the PDF / audit-pack that external auditors
        // open.
        expect(repoArgs.title).toBe('SANITISED(<b>Q4</b>)');
        expect(repoArgs.auditScope).toBe('SANITISED(<script>alert(1)</script>)');
        expect(repoArgs.criteria).toBe('SANITISED(criteria-text)');
        expect(repoArgs.auditors).toBe('SANITISED(Alice;Bob)');
        expect(repoArgs.auditees).toBe('SANITISED(Carol)');
        expect(repoArgs.departments).toBe('SANITISED(Eng;Ops)');
    });

    it('persists status=PLANNED by default', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockCreate.mock.calls[0][2].status).toBe('PLANNED');
    });

    it('generateChecklist=true creates 10 standard items + control-derived items', async () => {
        const controls = Array.from({ length: 5 }, (_, i) => ({
            id: `c${i}`, name: `Control ${i}`, code: `A.${i}`,
        }));
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) =>
            fn(fakeDbWithControls(controls) as never),
        );

        await createAudit(makeRequestContext('EDITOR'), {
            title: 'Q4',
            generateChecklist: true,
        });

        // 10 baseline + 5 control-derived = 15
        expect(mockCreateItem).toHaveBeenCalledTimes(15);
    });

    it('generateChecklist=false (default) creates NO checklist items', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockCreateItem).not.toHaveBeenCalled();
    });

    it('emits CREATE Audit audit', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(fakeDbWithControls() as never));

        await createAudit(makeRequestContext('EDITOR'), { title: 'Q4' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'CREATE',
                entityType: 'Audit',
            }),
        );
    });
});

describe('updateAudit', () => {
    it('throws notFound on missing audit (cross-tenant id)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));
        mockUpdate.mockResolvedValueOnce(null as never);

        await expect(
            updateAudit(makeRequestContext('EDITOR'), 'missing', { title: 'x' }),
        ).rejects.toThrow(/Audit not found/);
    });

    it('rejects READER on update (canWrite)', async () => {
        await expect(
            updateAudit(makeRequestContext('READER'), 'a1', { title: 'x' }),
        ).rejects.toThrow();
    });

    it('preserves "untouched" semantics on undefined fields (no SET on update)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await updateAudit(makeRequestContext('EDITOR'), 'a1', { title: 'new' });

        const repoArgs = mockUpdate.mock.calls[0][3];
        // Regression: a flatten that turned `sanitizeOptional` into
        // `sanitize(v ?? '')` would silently SET '' on every column — a
        // single-field PATCH would wipe encrypted state across the row.
        expect(repoArgs.title).toBe('SANITISED(new)');
        expect(repoArgs.auditScope).toBeUndefined();
        expect(repoArgs.criteria).toBeUndefined();
        expect(repoArgs.auditors).toBeUndefined();
    });

    it('sanitises notes per checklistUpdates element (encrypted column)', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await updateAudit(makeRequestContext('EDITOR'), 'a1', {
            title: 'x',
            checklistUpdates: [
                { id: 'i1', result: 'PASS', notes: '<script>x</script>' },
                { id: 'i2', result: 'FAIL', notes: 'plain note' },
            ],
        });

        // Each item gets sanitised individually — the per-element
        // wrapper protects evidence trails on PDF export.
        expect(mockUpdateItem).toHaveBeenCalledTimes(2);
        const firstNoteArg = (mockUpdateItem.mock.calls[0] as any[])[3];
        expect(firstNoteArg.notes).toBe('SANITISED(<script>x</script>)');
        const secondNoteArg = (mockUpdateItem.mock.calls[1] as any[])[3];
        expect(secondNoteArg.notes).toBe('SANITISED(plain note)');
        // result is enum-shaped — must NOT be sanitised (would mangle the value).
        expect(firstNoteArg.result).toBe('PASS');
    });

    it('emits UPDATE Audit audit', async () => {
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn({} as never));

        await updateAudit(makeRequestContext('EDITOR'), 'a1', { title: 'x' });

        expect(mockLog).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                action: 'UPDATE',
                entityType: 'Audit',
            }),
        );
    });
});

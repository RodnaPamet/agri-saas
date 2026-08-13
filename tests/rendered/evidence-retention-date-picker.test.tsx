/**
 * Epic 58 — single-date picker rollout tests.
 *
 * Covers the highest-value form fields migrated from a native
 * `<input type="date">` to the shared `<DatePicker>`:
 *
 *   - Upload Evidence modal's "Retain until" field.
 *   - Evidence list's inline retention-edit (now the Edit modal).
 *
 * GRC teardown phase 2 deleted the policy detail page, so its
 * "Next review" field — the third rollout surface this file covered —
 * has no subject left. The evidence surfaces are untouched.
 *
 * These are structural contract checks. They fail loudly if a future
 * refactor drops the shared picker (e.g. for a new native input) or
 * breaks the YMD ↔ ISO bridging the retention API
 * has always consumed. The DatePicker's own behaviour is exercised
 * separately by `tests/rendered/date-pickers.test.tsx` and
 * `tests/rendered/date-picker-ui.test.tsx`.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

const EVIDENCE_UPLOAD =
    'src/app/t/[tenantSlug]/(app)/evidence/UploadEvidenceModal.tsx';
const EVIDENCE_CLIENT =
    'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx';
// Retention editing moved out of the EvidenceClient table column and into
// the evidence Edit modal (2026-06-05). The DatePicker now lives here.
const EDIT_EVIDENCE_MODAL =
    'src/app/t/[tenantSlug]/(app)/evidence/EditEvidenceModal.tsx';
// GRC teardown phase 2 removed POLICY_DETAIL
// (`.../(app)/policies/[policyId]/page.tsx`) with the Policy model.

// Surfaces that carry a retention/expiry DatePicker.
const DATE_PICKER_FILES = [EVIDENCE_UPLOAD, EDIT_EVIDENCE_MODAL];
// Surfaces that must never reintroduce a native <input type="date">.
const EVIDENCE_FILES = [EVIDENCE_UPLOAD, EVIDENCE_CLIENT, EDIT_EVIDENCE_MODAL];

describe('Epic 58 — DatePicker imports', () => {
    it.each(DATE_PICKER_FILES)(
        '%s imports the shared DatePicker',
        (file) => {
            const src = read(file);
            expect(src).toMatch(
                /import\s*\{[^}]*\bDatePicker\b[^}]*\}\s*from\s*['"]@\/components\/ui\/date-picker\/date-picker['"]/,
            );
        },
    );

    it.each(DATE_PICKER_FILES)(
        '%s bridges YMD strings with parseYMD / toYMD at the picker edge',
        (file) => {
            const src = read(file);
            expect(src).toMatch(/\bparseYMD\b[^;]*from\s*['"]@\/components\/ui\/date-picker\/date-utils['"]/);
            expect(src).toMatch(/\btoYMD\b[^;]*from\s*['"]@\/components\/ui\/date-picker\/date-utils['"]/);
        },
    );
});

describe('Epic 58 — no native date inputs on evidence surfaces', () => {
    // Evidence is the highest-value rollout surface in Epic 58; both
    // the upload modal and the inline retention edit must use the
    // shared picker, full stop. Any new `<input type="date">` on
    // these two files is a regression.
    it.each(EVIDENCE_FILES)(
        '%s no longer contains <input type="date">',
        (file) => {
            const src = read(file);
            // Match the JSX form specifically so the guardrail comment
            // that mentions the old widget doesn't trip the check.
            expect(src).not.toMatch(/<input\b[^>]*\btype=["']date["']/);
        },
    );
});

describe('Epic 58 — DatePicker call-site invariants', () => {
    interface Site {
        label: string;
        src: string;
        /**
         * Capture the full set of props for a given DatePicker call
         * so the assertions can look at every prop at once rather
         * than scanning slice windows.
         */
        datePickerBlocks: string[];
    }

    function findDatePickerBlocks(src: string): string[] {
        // A crude but dependable parser: find each `<DatePicker`
        // occurrence and capture up to the first self-closing `/>`
        // that follows at the same nesting level. Works because
        // none of our migrated usages nest JSX children.
        const blocks: string[] = [];
        let cursor = 0;
        while (cursor < src.length) {
            const start = src.indexOf('<DatePicker', cursor);
            if (start === -1) break;
            const end = src.indexOf('/>', start);
            if (end === -1) break;
            blocks.push(src.slice(start, end + 2));
            cursor = end + 2;
        }
        return blocks;
    }

    const sites: Site[] = [
        {
            label: 'UploadEvidenceModal',
            src: read(EVIDENCE_UPLOAD),
            datePickerBlocks: [],
        },
        {
            label: 'EditEvidenceModal',
            src: read(EDIT_EVIDENCE_MODAL),
            datePickerBlocks: [],
        },
        // GRC teardown phase 2 removed the PolicyDetail site with the
        // policy detail page. The two evidence sites keep every
        // call-site invariant (clearable / disabledDays / YMD bridging)
        // under assertion.
    ];
    for (const s of sites) {
        s.datePickerBlocks = findDatePickerBlocks(s.src);
    }

    it.each(sites)(
        '$label renders at least one <DatePicker /> call',
        ({ datePickerBlocks }) => {
            expect(datePickerBlocks.length).toBeGreaterThan(0);
        },
    );

    it.each(sites)(
        '$label picker(s) declare `clearable` so expiry can be removed',
        ({ datePickerBlocks }) => {
            for (const block of datePickerBlocks) {
                expect(block).toMatch(/\bclearable\b/);
            }
        },
    );

    it.each(sites)(
        '$label picker(s) disable past days via { before: startOfUtcDay(new Date()) }',
        ({ datePickerBlocks }) => {
            for (const block of datePickerBlocks) {
                expect(block).toMatch(
                    /disabledDays=\{\{\s*before:\s*startOfUtcDay\(new Date\(\)\)\s*,?\s*\}\}/,
                );
            }
        },
    );

    it.each(sites)(
        '$label picker(s) are wired through parseYMD / toYMD',
        ({ datePickerBlocks }) => {
            for (const block of datePickerBlocks) {
                expect(block).toMatch(/value=\{parseYMD\(/);
                expect(block).toMatch(/toYMD\(next\)/);
            }
        },
    );
});

describe('Epic 58 — existing API contracts preserved', () => {
    it('Upload Evidence keeps retentionUntil id + YMD → ISO conversion on submit', () => {
        const src = read(EVIDENCE_UPLOAD);
        // E2E selects the retention field by id — must survive the
        // migration (DatePicker forwards `id` to its trigger).
        expect(src).toMatch(/id=["']retention-date-input["']/);
        // Post-migration the modal still converts the stored YMD
        // string to an ISO timestamp for the /retention endpoint.
        // After the mutation refactor (vars-destructured handler), the
        // retention value lives on the mutation `vars` object, not
        // the bare closure variable — match either shape so the test
        // asserts the conversion contract regardless of plumbing.
        // Allow optional trailing comma (Prettier formats multiline
        // function calls with trailing commas).
        expect(src).toMatch(
            /new Date\(\s*(vars\.)?retentionUntil\s*,?\s*\)\.toISOString\(\)/,
        );
    });

    it('Edit modal retention posts { retentionUntil: ISO | null, retentionPolicy } to /retention', () => {
        const src = read(EDIT_EVIDENCE_MODAL);
        expect(src).toMatch(/\/evidence\/\$\{initial\.id\}\/retention/);
        expect(src).toMatch(
            /retentionUntil:\s*retentionDate\s*[\s\S]*?new Date\(retentionDate\)[\s\S]*?\.toISOString\(\)[\s\S]*?:\s*null/,
        );
        expect(src).toMatch(/retentionPolicy:\s*retentionDate\s*\?\s*['"]FIXED_DATE['"]/);
    });

    it('EvidenceClient retention column is display-only (no inline editor)', () => {
        const src = read(EVIDENCE_CLIENT);
        // The inline edit state + handler were removed when retention
        // moved to the modal.
        expect(src).not.toMatch(/editingRetention/);
        expect(src).not.toMatch(/saveRetention/);
        // The status badge + resolved date stay (display).
        expect(src).toMatch(/retention-status-\$\{ev\.id\}/);
    });

    // GRC teardown phase 2 removed the policy "Next review" field-id
    // contract along with the policy detail page.
});

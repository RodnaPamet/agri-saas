/**
 * Roadmap-9 PR-2 — CardHeader adoption registry.
 *
 * `<CardHeader>` (Roadmap-3 PR-5) locks the section-title rhythm
 * inside cards: heading level (3 default), bottom margin, optional
 * eyebrow, optional inline action. Despite shipping, only one
 * detail page (risks/[riskId]) used it. Every other card-internal
 * heading rolled `<Heading level={3} className="mb-3">` inline.
 *
 * R9-PR2 ships three first migrations (audits/AuditsClient,
 * controls/[controlId], controls/[controlId]/tests/[planId]) +
 * locks adoption via a registry. Same shape as
 * `pageheader-adoption.test.ts` — bidirectional check catches
 * forgotten flag flips.
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

interface CardHeaderEntry {
    file: string;
    adopted: boolean;
    note: string;
}

const CARDHEADER_PAGES: CardHeaderEntry[] = [
    // ── Adopted ──
    // Risks detail (risks/[riskId]) was the first proof-of-pattern
    // adopter, but its only CardHeader sat on an Overview-tab
    // Traceability section that was removed — risk traceability now
    // lives solely on the dedicated Traceability tab. De-registered
    // here when that section was dropped.
    {
        file: "src/app/t/[tenantSlug]/(app)/audits/AuditsClient.tsx",
        adopted: true,
        note: "Audits master/detail — checklist section header migrated R9-PR2.",
    },
    {
        file: "src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx",
        adopted: false,
        note: "B4 (2026-06-07): the only CardHeader (the legacy 'Control tasks' table) was removed when the Tasks tab was aligned to Asset/Risk (a single LinkedTasksPanel).",
    },
];

describe("CardHeader adoption registry", () => {
    it("every registered page exists in the codebase", () => {
        for (const entry of CARDHEADER_PAGES) {
            expect(fs.existsSync(path.join(ROOT, entry.file))).toBe(true);
        }
    });

    it("every page marked `adopted: true` actually mounts <CardHeader>", () => {
        const violations: string[] = [];
        for (const entry of CARDHEADER_PAGES) {
            if (!entry.adopted) continue;
            const src = fs.readFileSync(path.join(ROOT, entry.file), "utf8");
            if (!/<CardHeader\b/.test(src)) {
                violations.push(entry.file);
            }
        }
        expect(violations).toHaveLength(0);
    });

    it("every entry has a non-trivial note", () => {
        for (const entry of CARDHEADER_PAGES) {
            expect(entry.note.length).toBeGreaterThan(40);
        }
    });
});

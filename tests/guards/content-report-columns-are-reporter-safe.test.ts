/**
 * Guard: no column lands on `ContentReport` without a note saying it is safe
 * for the REPORTER to read (#1553).
 *
 * ## Why this table and not the other three
 *
 * `ContentReport` carries a fourth RLS policy arm that the other two
 * moderation tables do not — `content_report_reporter_read`, added on the
 * owner's decision of 2026-10-10 so a reporter can read their own notice back
 * and "my reports" is possible without a second read path.
 *
 * **Postgres RLS is ROW-level, not column-level.** That arm therefore exposes
 * EVERY column of the reporter's own row, now and forever after. It is safe
 * today only because the moderation internals — the decision, the rationale,
 * `moderatorRef`, the action history — live on `ModerationAction` and
 * `StatementOfReasons`. Had they lived here, the arm would have leaked all of
 * it and the right answer would have been a separate receipt projection.
 *
 * So the three-table split stopped being a tidiness choice and became
 * load-bearing, and the consequence is the thing this guard exists for:
 * anything added to this model later is, by construction, reporter-visible.
 * A moderator note added here "just for convenience" would be readable by the
 * person it is about, and nothing else in the tree would say so.
 *
 * ## Why a note per column rather than a count
 *
 * A count would pass a column SWAP, and more importantly it would record
 * nothing. The failure this prevents is not someone adding a column
 * carelessly — it is someone adding one thoughtfully, for a good reason,
 * without knowing about the arm. A note per column puts the question in front
 * of them at the moment they have to edit this file, which a number does not.
 *
 * ## Both directions
 *
 * The population is DERIVED from the DMMF, so a new column is in scope the
 * moment it exists. And the map must not carry a STALE entry: an entry for a
 * column that has been removed is a note about nothing, which misleads the
 * next reader in the opposite direction. Set equality, both ways.
 */
import { Prisma } from '@prisma/client';

const MODEL = 'ContentReport';

/**
 * Every column, with why a reporter may read it.
 *
 * Adding a column means adding an entry here. If you cannot write the reason,
 * that is the answer: it belongs on `ModerationAction` instead.
 */
const REPORTER_SAFE: Readonly<Record<string, string>> = {
    id: 'The row id. The reporter submitted it; an opaque cuid tells them nothing they did not already have.',
    createdAt:
        'When they filed it — a timestamp of their own submission. It also carries no information about moderation: the triage clock lives on ModerationAction.',
    reporterUserId:
        'Their own id, and the column the policy arm matches on — a reporter who could not read it could not be matched by it. NULL on an anonymous notice, which then matches nobody.',
    subjectKind:
        'What they reported. Supplied by the reporter, so reading it back is a receipt rather than a disclosure.',
    subjectId: 'Likewise supplied by the reporter.',
    reasonCode:
        'The category they picked from the enum. Their own input, read back; it is an enum precisely so a count by reason needs nobody to read a detail field.',
    detail:
        'Their own words. ENCRYPTED at rest, and decrypted under the global KEK for exactly this reader — see GLOBAL_KEK_MODELS.',
    status:
        'DELIBERATE, and the one entry worth arguing. It reveals that a notice was TRIAGED, ACTIONED or REJECTED — which is an outcome the reporter is entitled to under DSA Art 16, and the reason the arm was wanted at all. It reveals no moderator identity, no rationale and no timing beyond its own row; all of that is on ModerationAction, which denies app_user outright.',
};

describe('every ContentReport column is reporter-safe (#1553)', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === MODEL);

    it('the model is in the datamodel at all — the denominator', () => {
        // Without this, every assertion below ranges over an empty field list
        // and a renamed or deleted model reads as a clean pass.
        expect(model).toBeDefined();
        expect(model!.fields.length).toBeGreaterThanOrEqual(7);
    });

    it('the field read discriminates — the control it needs', () => {
        // The assertions below compare two sets. If the DMMF read silently
        // returned nothing useful, set equality against an empty map would
        // still be satisfiable by emptying the map — so pin that the reader
        // finds a column that must exist and does not invent one.
        const names = model!.fields.map((f) => f.name);
        expect(names).toContain('reporterUserId');
        expect(names).not.toContain('moderatorRef');
        expect(names).not.toContain('rationale');
    });

    it('no column lacks a reporter-safety note', () => {
        const scalars = model!.fields.filter((f) => f.kind !== 'object').map((f) => f.name);
        const undocumented = scalars.filter((n) => !REPORTER_SAFE[n]);
        if (undocumented.length > 0) {
            throw new Error(
                `${undocumented.length} column(s) on ${MODEL} have no reporter-safety note:\n  ` +
                    undocumented.join('\n  ') +
                    `\n\n\`content_report_reporter_read\` is a ROW-level policy, so a reporter ` +
                    `reads EVERY column of their own row — including any you just added. ` +
                    `Postgres RLS cannot restrict that to a subset.\n\n` +
                    `Add an entry to REPORTER_SAFE in this file saying why the reporter may ` +
                    `read it. If you cannot write that sentence, the column belongs on ` +
                    `\`ModerationAction\` or \`StatementOfReasons\`, which deny \`app_user\` ` +
                    `outright — that is what the three-table split is FOR.`,
            );
        }
    });

    it('every note has a real reason, not a placeholder', () => {
        const thin = Object.entries(REPORTER_SAFE)
            .filter(([, reason]) => !reason || reason.trim().length < 25)
            .map(([n]) => n);
        expect(thin).toEqual([]);
    });

    it('no note describes a column that no longer exists', () => {
        // The other direction. A note about a removed column is a statement
        // about nothing, and it misleads the next reader into thinking the
        // question was asked about the table as it stands.
        const scalars = new Set(
            model!.fields.filter((f) => f.kind !== 'object').map((f) => f.name),
        );
        const stale = Object.keys(REPORTER_SAFE).filter((n) => !scalars.has(n));
        expect(stale).toEqual([]);
    });

    it('the moderation internals are NOT on this table — why the arm is safe', () => {
        // The premise the whole arm rests on, asserted rather than trusted.
        // If a future change moved any of these onto ContentReport, the note
        // requirement above would still be satisfiable by writing a note —
        // so this names the specific columns whose presence would invalidate
        // the safety argument itself.
        const names = new Set(model!.fields.map((f) => f.name));
        for (const forbidden of ['moderatorRef', 'rationale', 'actionKind', 'bodyRendered']) {
            expect(names.has(forbidden)).toBe(false);
        }
        // And they are where they belong, so this is not vacuous.
        const action = Prisma.dmmf.datamodel.models.find((m) => m.name === 'ModerationAction');
        expect(action).toBeDefined();
        const actionFields = action!.fields.map((f) => f.name);
        expect(actionFields).toContain('moderatorRef');
        expect(actionFields).toContain('rationale');
    });
});

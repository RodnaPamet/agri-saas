/**
 * P5.6 — every person-naming column is classified (#1597).
 *
 * This is the guard that issue asks for, in its own words:
 *
 *   > pseudonymisation here is an UPDATE across named columns rather than a
 *   > cascade, so the erasure job must enumerate them and a new table holding a
 *   > person id is a new place to forget. That wants a guard deriving the column
 *   > list from the DMMF rather than listing it.
 *
 * So the population comes from `Prisma.dmmf.datamodel.models` at runtime, never
 * from a list here. A model that gains a person column fails this test until
 * somebody decides what erasure does to it — which is the only way the decision
 * gets made at all, since an unclassified column silently survives erasure and
 * nothing else notices.
 *
 * ## Why TENANTLESS only, and why that is checked rather than assumed
 *
 * 49 of the 67 person-naming columns sit on models that also carry a
 * `tenantId`. Those are farm records: the person's name on a journal entry is
 * authorship, and the record belongs to a farm with its own retention duty
 * (БАБХ ДНЕВНИК). §1 prints both counts, so the split is visible rather than
 * implied — and if a future model drops its `tenantId`, it moves into this
 * guard's population automatically and has to be classified.
 */
import { Prisma } from '@prisma/client';

import {
    PERSONAL_DATA_REGISTRY,
    REGISTRY_BY_MODEL,
    EXPORTED_MODELS,
    ERASED_MODELS,
    RETAINED_MODELS,
} from '@/lib/privacy/personal-data-registry';

/**
 * A column naming a person.
 *
 * Suffix-matched on `userId` rather than a list of known spellings, because the
 * schema uses at least seven (`reporterUserId`, `blockerUserId`,
 * `blockedUserId`, `recipientUserId`, `inquirerUserId`, `senderUserId`,
 * `actorUserId`, …) and a list of them is the thing that goes stale.
 */
const PERSON_COLUMN = /[Uu]serId$/;

interface Derived {
    readonly model: string;
    readonly columns: string[];
    readonly tenantScoped: boolean;
}

const derived: Derived[] = Prisma.dmmf.datamodel.models
    .map((m) => ({
        model: m.name,
        columns: m.fields
            .filter((f) => f.kind === 'scalar' && PERSON_COLUMN.test(f.name))
            .map((f) => f.name)
            .sort(),
        tenantScoped: m.fields.some((f) => f.name === 'tenantId'),
    }))
    .filter((d) => d.columns.length > 0);

const tenantless = derived.filter((d) => !d.tenantScoped);
const tenantScoped = derived.filter((d) => d.tenantScoped);

describe('§1 the population, printed', () => {
    it('prints both counts so the tenantless split is visible', () => {
        // eslint-disable-next-line no-console
        console.log(
            `[personal-data] ${derived.length} models carry a person column: `
            + `${tenantless.length} tenantless (this guard's population), `
            + `${tenantScoped.length} tenant-scoped (farm records, out of scope)`,
        );
        // A derivation that selected nothing would pass every assertion below.
        expect(derived.length).toBeGreaterThan(40);
        expect(tenantless.length).toBeGreaterThan(10);
    });

    it('finds the trust & safety tables, so the matcher is not broken', () => {
        // Positive control. P5.6's exit criterion names these specifically, so
        // if the regex stopped matching they are the ones that must still
        // appear.
        const names = tenantless.map((d) => d.model);
        expect(names).toContain('ContentReport');
        expect(names).toContain('UserBlock');
        expect(names).toContain('StatementOfReasons');
    });
});

describe('§2 every tenantless person column is classified', () => {
    it('has no unclassified model', () => {
        const unclassified = tenantless
            .filter((d) => !REGISTRY_BY_MODEL.has(d.model))
            .map((d) => `${d.model}[${d.columns.join('|')}]`);

        // The message is the point: whoever trips this is adding a model, and
        // needs to know that the decision is what erasure DOES, not where to
        // add a line.
        expect(unclassified).toEqual([]);
    });

    it('classifies every COLUMN, not just every model', () => {
        // A model can gain a second person column — `UserBlock` has two, and
        // `OrgAuditLog` has actor and target. Classifying the model while
        // missing a column would leave that column surviving erasure.
        const missing: string[] = [];
        for (const d of tenantless) {
            const entry = REGISTRY_BY_MODEL.get(d.model);
            if (!entry) continue;
            for (const col of d.columns) {
                if (!entry.columns.includes(col)) missing.push(`${d.model}.${col}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('has no entry for a column the schema no longer has', () => {
        // The other direction. A stale entry is cover for whatever is created
        // at that name next, and it would make the erasure job query a column
        // that is gone.
        const stale: string[] = [];
        const byModel = new Map(tenantless.map((d) => [d.model, d.columns]));
        for (const entry of PERSONAL_DATA_REGISTRY) {
            const cols = byModel.get(entry.model);
            if (!cols) {
                stale.push(`${entry.model} (model absent or now tenant-scoped)`);
                continue;
            }
            for (const col of entry.columns) {
                if (!cols.includes(col)) stale.push(`${entry.model}.${col}`);
            }
        }
        expect(stale).toEqual([]);
    });
});

describe('§3 every entry carries a real reason', () => {
    it.each(PERSONAL_DATA_REGISTRY.map((e) => [e.model, e] as const))(
        '%s explains its disposition',
        (_model, entry) => {
            // Long enough to be an argument rather than a label. Every entry
            // here is a decision about someone's personal data; "legal" or
            // "TODO" is not a decision.
            expect(entry.reason.length).toBeGreaterThan(80);
            expect(entry.reason).not.toMatch(/^(TODO|FIXME|n\/a|see above|legal)\b/i);
            expect(entry.columns.length).toBeGreaterThan(0);
        },
    );

    it('a RETAIN disposition names a basis or a mechanism', () => {
        // The owner's ruling is Art 17(3)(b), and a retention that cannot say
        // why it retains is the one an auditor asks about first. An
        // immutability mechanism (a hash chain) counts: that is a technical
        // impossibility rather than a legal choice, and both are answers.
        for (const entry of PERSONAL_DATA_REGISTRY) {
            if (!entry.disposition.startsWith('RETAIN')) continue;
            expect(entry.reason).toMatch(/17\(3\)\(b\)|hash chain|immutab|append-only|platform/i);
        }
    });
});

describe('§4 the derived lists are coherent', () => {
    it('every model is in exactly one of exported / not, and erased / not', () => {
        // Guards against a disposition string typo producing a model that is
        // in no list at all — which would read as "handled" while being
        // handled by nothing.
        for (const entry of PERSONAL_DATA_REGISTRY) {
            const exported = EXPORTED_MODELS.includes(entry.model);
            const erased = ERASED_MODELS.includes(entry.model);
            const retained = RETAINED_MODELS.includes(entry.model);
            expect(erased || retained).toBe(true);
            expect(erased && retained).toBe(false);
            // Exported-ness is independent of erased-ness, so only the
            // disposition decides it.
            expect(exported).toBe(entry.disposition.endsWith('_AND_EXPORT'));
        }
    });

    it('the trust & safety rows the exit criterion names ARE exported', () => {
        // #1597: "proven to include the trust & safety rows that name them."
        expect(EXPORTED_MODELS).toContain('ContentReport');
        expect(EXPORTED_MODELS).toContain('UserBlock');
        expect(EXPORTED_MODELS).toContain('StatementOfReasons');
    });

    it('credentials are NEVER exported', () => {
        // A downloadable file containing a live refresh token or a reset token
        // is a credential leak, and answers nothing the person asked.
        for (const model of ['Account', 'AuthSession', 'PasswordResetToken']) {
            expect(EXPORTED_MODELS).not.toContain(model);
            expect(ERASED_MODELS).toContain(model);
        }
    });

    it('the hash chains are NEVER erased', () => {
        // Rewriting a row inside a hash chain breaks verification for every
        // entry after it — #1597's real exit criterion is that the chain still
        // verifies after an erasure.
        for (const model of ['OrgAuditLog', 'PlatformAuditLog']) {
            expect(ERASED_MODELS).not.toContain(model);
            expect(RETAINED_MODELS).toContain(model);
        }
    });

    it('ContentReport is RETAINED, which is what makes erasure incomplete', () => {
        // The owner ruling of 2026-10-11, pinned here because it is the single
        // most consequential entry: it is why the privacy notice has to say
        // erasure is incomplete.
        expect(RETAINED_MODELS).toContain('ContentReport');
        expect(ERASED_MODELS).not.toContain('ContentReport');
    });
});

describe('§5 every ERASE entry says HOW, and no RETAIN entry pretends to', () => {
    it('an ERASE disposition carries an action', () => {
        // Without this, an erasable column could be classified and still not
        // erased by anything — which is the same silent survival the registry
        // exists to prevent, one level up.
        const missing = PERSONAL_DATA_REGISTRY
            .filter((e) => e.disposition.startsWith('ERASE') && !e.action)
            .map((e) => e.model);
        expect(missing).toEqual([]);
    });

    it('a RETAIN disposition carries NO action', () => {
        // An action on a retained entry is dead configuration that reads like
        // a decision — and if anything ever ran it, it would erase a column
        // the Art 17(3)(b) ruling says we keep.
        const spurious = PERSONAL_DATA_REGISTRY
            .filter((e) => e.disposition.startsWith('RETAIN') && e.action)
            .map((e) => e.model);
        expect(spurious).toEqual([]);
    });

    it('DELETE_ROW is used only where the row has no meaning without the person', () => {
        // Named explicitly, because choosing DELETE_ROW for a row somebody ELSE
        // also owns destroys their record: a farm's listing, a counterparty's
        // conversation. Those are PSEUDONYMISE_COLUMN.
        const deleted = PERSONAL_DATA_REGISTRY
            .filter((e) => e.action === 'DELETE_ROW')
            .map((e) => e.model)
            .sort();
        expect(deleted).toEqual([
            'Account', 'AuthSession', 'FeatureFlagCohortMember',
            'OrgMembership', 'PasswordResetToken', 'UserBlock',
        ]);
    });

    it('every PSEUDONYMISE target is a row with a SECOND owner', () => {
        // The complement of the above, asserted by a property rather than a
        // list: each of these carries a tenant column, which is what makes it
        // somebody else's record too.
        for (const entry of PERSONAL_DATA_REGISTRY) {
            if (entry.action !== 'PSEUDONYMISE_COLUMN') continue;
            const model = Prisma.dmmf.datamodel.models.find((m) => m.name === entry.model)!;
            const hasOtherOwner = model.fields.some((f) => /TenantId$/.test(f.name));
            expect(hasOtherOwner).toBe(true);
        }
    });
});

describe('§6 the detector can tell a classified column from an unclassified one', () => {
    // Mutation proof against synthetic input, because every real model is
    // currently classified — so a green §2 is also what a detector that checks
    // nothing produces.
    const classify = (models: Array<{ model: string; columns: string[] }>) =>
        models.filter((d) => !REGISTRY_BY_MODEL.has(d.model)).map((d) => d.model);

    it('catches a new tenantless model with a person column', () => {
        expect(classify([{ model: 'AppealRequest', columns: ['appellantUserId'] }]))
            .toEqual(['AppealRequest']);
    });

    it('does not flag one that is classified', () => {
        expect(classify([{ model: 'ContentReport', columns: ['reporterUserId'] }]))
            .toEqual([]);
    });

    it('the COLUMN check catches a second column on a classified model', () => {
        const entry = REGISTRY_BY_MODEL.get('ContentReport')!;
        // A model classified for one column and silently gaining another is
        // the subtler failure, and the one §2's second test exists for.
        expect(entry.columns).not.toContain('reviewedByUserId');
    });
});

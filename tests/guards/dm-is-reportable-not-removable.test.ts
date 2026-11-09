/**
 * A direct message is REPORTABLE and not REMOVABLE (#2833, owner ruling
 * 2026-11-08).
 *
 * ## Why this is a source guard and not a behavioural test
 *
 * `tests/integration/moderation-content-removal.test.ts` asserts that
 * `CONTENT_REMOVED` on a `DIRECT_MESSAGE` is refused with
 * `MODERATION_ACTION_NOT_PERFORMABLE`, no action row and the notice still
 * `RECEIVED`. That test is correct and it **cannot see this ruling being
 * reversed** — measured, by adding `DIRECT_MESSAGE` to
 * `REMOVABLE_SUBJECT_KINDS` and watching all nine of its cases stay green.
 *
 * The reason is that the refusal has TWO layers which are deliberately
 * indistinguishable from outside: `assertPerformable` refuses any kind outside
 * `REMOVABLE_SUBJECT_KINDS`, and `removeSubjectOnTx`'s `default:` arm throws
 * the identical code for a kind that got past it. Both are intentional — the
 * second exists so that adding a kind to the list without an arm fails loudly
 * rather than recording an unperformed removal — and together they mean the
 * observable is the same whether the ruling holds or has been reversed.
 *
 * So the behavioural test owns the OUTCOME and this owns the RULING. A probe
 * that returns the same answer in both worlds has no discriminating power, and
 * the honest fix is a second probe rather than a louder claim on the first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { blankNonCode } from '../helpers/blank-non-code';
import { readPrismaSchema } from '../helpers/prisma-schema';
import { collectSourceFiles } from '../helpers/collect-files';

const MODERATION = join(process.cwd(), 'src/app-layer/usecases/moderation.ts');
const SCHEMAS = join(process.cwd(), 'src/lib/schemas/index.ts');

/** The literal members of a `const X = [...] as const;` array. */
function members(src: string, name: string): string[] {
    const at = src.indexOf(`const ${name} = [`);
    if (at < 0) return [];
    const open = src.indexOf('[', at);
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === '[') depth += 1;
        else if (src[i] === ']') {
            depth -= 1;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0) return [];
    return [...src.slice(open, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('a direct message is reportable and not removable (#2833)', () => {
    // Comments blanked: both files ARGUE about these lists at length, and a
    // kind named in a docblock is not a kind in a list.
    const moderation = blankNonCode(readFileSync(MODERATION, 'utf8'));
    const schemas = blankNonCode(readFileSync(SCHEMAS, 'utf8'));

    const removable = members(moderation, 'REMOVABLE_SUBJECT_KINDS');
    const reportable = members(schemas, 'REPORT_SUBJECT_KINDS');

    it('[dm-reportable-not-removable] prints both populations — the denominator', () => {
        // [dm-reportable-not-removable] A floor separates zero from nonzero;
        // the READING is what shows a list quietly emptying while still above
        // its floor, which would make every assertion below vacuous.
        console.log(
            `[dm-reportable-not-removable] removable ${removable.length} `
            + `(${removable.join(', ')}); reportable ${reportable.length} `
            + `(${reportable.join(', ')})`,
        );
        expect(removable.length).toBeGreaterThan(1);
        expect(reportable.length).toBeGreaterThan(3);
    });

    it('DIRECT_MESSAGE is REPORTABLE', () => {
        expect(reportable).toContain('DIRECT_MESSAGE');
    });

    it('DIRECT_MESSAGE is NOT removable — the ruling', () => {
        // Owner ruling 2026-11-08: suspension is the remedy for DM abuse this
        // release. `DirectMessage` has no `removedByModerationAt` column, so a
        // removal has nothing to write even if it were permitted — adding the
        // kind here would make `removeSubjectOnTx` reach its `default:` and
        // refuse with the same code, which is why the behavioural test cannot
        // tell the two apart.
        expect(removable).not.toContain('DIRECT_MESSAGE');
    });

    it('nothing RESTATES the kinds as a hand-written union', () => {
        // #2833 found a THIRD copy: `ReportDialog.tsx` carried
        // `type ReportSubjectKind = 'LISTING' | 'MESSAGE' | 'PROFILE' |
        // 'THREAD'`, which went stale the moment a kind was added, and
        // `report-subject-kinds-mirror` could not see it because that guard
        // compares the zod list to the PRISMA enum. It is derived now —
        // `(typeof REPORT_SUBJECT_KINDS)[number]` — so the drift is structurally
        // impossible rather than merely absent.
        //
        // This asserts nobody restates it again, which is the edit that looks
        // harmless: a client component wanting the type without the import.
        // The bundle reason that justifies `FarmRiskClient`'s own `RiskLevel`
        // copy does not apply to a plain string array.
        const files = collectSourceFiles({
            roots: ['src'],
            // A floor near reality, not 1: this sweep asserts an ABSENCE, so an
            // exclude predicate that ate the population would pass for free.
            floor: 2000,
        });
        const offenders: string[] = [];
        for (const f of files) {
            const code = blankNonCode(readFileSync(f, 'utf8'));
            // A union of two or more of the kinds, written out.
            if (/'(?:LISTING|MESSAGE|PROFILE|THREAD|DIRECT_MESSAGE)'\s*\|\s*'(?:LISTING|MESSAGE|PROFILE|THREAD|DIRECT_MESSAGE)'/.test(code)) {
                offenders.push(f.replace(`${process.cwd()}/`, ''));
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the kinds that ARE removable each have a column to write', () => {
        // The other direction, and what makes the assertion above a rule rather
        // than a preference: a kind is removable exactly when its table carries
        // `removedByModerationAt`. Derived from the schema so that adding a
        // kind to the list without the column fails here.
        // The map is HAND-KEPT on purpose: a new removable kind cannot ship
        // without somebody naming the model whose column gets written, which
        // is the forcing function this test is for. P9.3c added
        // `CHANNEL_POST` and this failed with `model: undefined` until the
        // entry existed — working exactly as intended.
        const MODEL_FOR: Record<string, string> = {
            LISTING: 'ExchangeListing',
            MESSAGE: 'ExchangeMessage',
            CHANNEL_POST: 'ChannelPost',
        };

        // The WHOLE multi-file schema, through the shared helper. This read
        // `exchange.prisma` alone, and `ChannelPost` lives in
        // `channels.prisma` — a hardcoded file is right only while every
        // removable kind happens to sit in one domain, which GAP-09's
        // multi-file schema makes a coincidence rather than a rule.
        //
        // `readPrismaSchema()` rather than a local `readdirSync`: that is the
        // repo's one definition (it caches, and it sorts so the concatenation
        // is stable), and a hand-rolled file walk in a guard is what
        // `file-collection-is-not-silently-empty` refuses.
        const schema = readPrismaSchema();

        for (const kind of removable) {
            const model = MODEL_FOR[kind];
            expect(model).toBeDefined();
            const at = schema.indexOf(`model ${model} {`);
            // A model named in the map but absent from every schema file would
            // otherwise slice from -1 and silently grade the wrong text.
            expect(at).toBeGreaterThanOrEqual(0);
            const own = schema.slice(at, schema.indexOf('\n}', at));
            expect(own).toContain('removedByModerationAt');
        }
    });
});

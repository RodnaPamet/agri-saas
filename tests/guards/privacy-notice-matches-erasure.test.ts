/**
 * P5.6 — the privacy notice says what actually survives erasure (#1597).
 *
 * This is the issue's third exit criterion, and the only one that is a claim
 * about PROSE:
 *
 *   > *The privacy notice states what survives, matching what the code does.*
 *
 * A notice and an implementation drift silently, because nothing fails when
 * they disagree — and here the direction of drift matters: the owner ruled the
 * basis is Art 17(3)(b), which means **a report stays linked to the person who
 * filed it**. A notice that omitted that would be telling people their data was
 * erased when it was not.
 *
 * So the guard reads `RETAINED_MODELS` from the registry the erasure itself
 * uses, and requires the notice to carry the corresponding disclosure in BOTH
 * locales. It cannot check that prose is *good*; it can check that the
 * load-bearing facts are present, and that they are present in Bulgarian too —
 * which is the locale almost every user of this deployment reads.
 */
import * as fs from 'fs';
import * as path from 'path';

import { RETAINED_MODELS, PERSONAL_DATA_REGISTRY } from '@/lib/privacy/personal-data-registry';

const ROOT = path.resolve(__dirname, '../..');

function messages(locale: 'en' | 'bg'): Record<string, Record<string, string>> {
    return JSON.parse(fs.readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'));
}

const en = messages('en').privacy;
const bg = messages('bg').privacy;

/** Keys P5.6 added. Named, because this guard is about THEIR content. */
const P56_KEYS = [
    'exportTitle', 'exportBody',
    'deleteTitle', 'deleteRequest', 'deleteWhatHappens', 'deleteIncomplete',
] as const;

describe('§1 the notice has the sections at all', () => {
    it.each(P56_KEYS)('%s exists in both locales', (key) => {
        // A missing key renders as the key name on a legal page, which is the
        // most embarrassing possible failure for this particular document.
        expect(typeof en[key]).toBe('string');
        expect(typeof bg[key]).toBe('string');
        expect(en[key].length).toBeGreaterThan(20);
        expect(bg[key].length).toBeGreaterThan(20);
    });

    it('the Bulgarian is actually Bulgarian', () => {
        // `i18n-bulgarian-cyrillic` holds this repo-wide; restated here because
        // an English paragraph pasted into `bg.json` on a privacy notice is a
        // compliance problem rather than a cosmetic one — the reader cannot
        // give informed consent to a document they cannot read.
        for (const key of P56_KEYS) {
            expect(bg[key]).toMatch(/[Ѐ-ӿ]/);
            expect(bg[key]).not.toBe(en[key]);
        }
    });

    it('the page RENDERS these keys, so they are not dead copy', () => {
        // The keys are reached through a `sections` array and a dynamic
        // `t(line)`, so a literal-`t('key')` scan cannot see them. Without
        // this, the copy could exist in both locales, pass parity, and appear
        // on no page at all.
        const page = fs.readFileSync(path.join(ROOT, 'src/app/privacy/page.tsx'), 'utf8');
        expect(page).toMatch(/key:\s*'export'/);
        expect(page).toMatch(/key:\s*'delete'/);
        for (const body of ['exportBody', 'deleteRequest', 'deleteWhatHappens', 'deleteIncomplete']) {
            expect(page).toContain(body);
        }
    });
});

describe('§2 what SURVIVES is disclosed, which is the exit criterion', () => {
    it('says erasure is incomplete rather than implying it is total', () => {
        // The sentence that makes the Art 17(3)(b) ruling honest. Matched on
        // meaning rather than wording, so the copy can be improved without
        // tripping this — but it has to keep saying the thing.
        expect(en.deleteIncomplete).toMatch(/cannot delete everything|not.{0,20}everything/i);
        expect(bg.deleteIncomplete).toMatch(/не можем да изтрием всичко/i);
    });

    it('names the legal basis, in both locales', () => {
        // A retention a reader cannot look up is a retention they cannot
        // challenge. Both the Act and the Article are named.
        expect(en.deleteIncomplete).toMatch(/Digital Services Act/i);
        expect(en.deleteIncomplete).toMatch(/17\(3\)\(b\)/);
        expect(bg.deleteIncomplete).toMatch(/цифровите услуги/i);
        expect(bg.deleteIncomplete).toMatch(/17/);
    });

    it('discloses the SPECIFIC survival: a report stays linked to its filer', () => {
        // `ContentReport` is the one RETAIN entry with a non-platform subject —
        // the others are hash chains, which no reader experiences. So this is
        // the survival a person actually needs told, and the guard derives
        // that from the registry rather than hard-coding the judgement.
        const reporterRetained = PERSONAL_DATA_REGISTRY.some(
            (e) => e.model === 'ContentReport' && e.disposition.startsWith('RETAIN'),
        );
        expect(reporterRetained).toBe(true);

        expect(en.deleteIncomplete).toMatch(/report stays linked|stays linked to you/i);
        expect(bg.deleteIncomplete).toMatch(/сигналът остава свързан/i);
    });

    it('discloses that the activity logs are never rewritten', () => {
        // `OrgAuditLog` and `PlatformAuditLog` are RETAIN_ONLY because a hash
        // chain cannot be rewritten without breaking verification. A reader is
        // entitled to know a record of them persists.
        for (const model of ['OrgAuditLog', 'PlatformAuditLog']) {
            expect(RETAINED_MODELS).toContain(model);
        }
        expect(en.deleteIncomplete).toMatch(/logs? (are|is) never rewritten|tamper-evident/i);
        expect(bg.deleteIncomplete).toMatch(/дневници/i);
    });
});

describe('§3 what is ERASED is described accurately', () => {
    it('says the email is REPLACED and the address freed, not that it is deleted', () => {
        // The mechanism matters to the reader for one practical reason: it
        // decides whether they can sign up again with the same address. They
        // can, because `pii-middleware` re-derives the lookup hash from the
        // tombstone email.
        expect(en.deleteWhatHappens).toMatch(/replaced/i);
        expect(en.deleteWhatHappens).toMatch(/sign up again|frees that address/i);
        expect(bg.deleteWhatHappens).toMatch(/замен/i);
        expect(bg.deleteWhatHappens).toMatch(/регистрирате отново/i);
    });

    it('says the pseudonym has no key kept', () => {
        // The difference between pseudonymisation and anonymisation, in the
        // one sentence a reader can act on. `eraseAccount` generates the
        // pseudonym locally and stores it nowhere.
        expect(en.deleteWhatHappens).toMatch(/random code|do not keep a key/i);
        expect(bg.deleteWhatHappens).toMatch(/случаен код|не пазим ключ/i);
    });

    it('names the grace period as a parameter, not a hard-coded number', () => {
        // `{graceDays}` is interpolated from `DELETION_GRACE_DAYS`, so the
        // notice and the sweep cannot disagree about the date. A literal "30"
        // in the copy is the drift this prevents.
        expect(en.deleteRequest).toContain('{graceDays}');
        expect(bg.deleteRequest).toContain('{graceDays}');
        expect(en.deleteWhatHappens).toContain('{graceDays}');
        expect(bg.deleteWhatHappens).toContain('{graceDays}');
    });
});

describe('§4 the export section states its boundaries', () => {
    it('names the three omissions, matching the code', () => {
        // The same three the response's `notIncluded` carries. A notice that
        // promised "everything" while the file omitted farm records would be
        // the drift this whole guard exists for.
        expect(en.exportBody).toMatch(/farm records/i);
        expect(en.exportBody).toMatch(/credential/i);
        expect(en.exportBody).toMatch(/blocks other people/i);
        expect(bg.exportBody).toMatch(/стопанските записи/i);
        expect(bg.exportBody).toMatch(/данните Ви за вход/i);
        expect(bg.exportBody).toMatch(/блокиранията, които други/i);
    });
});

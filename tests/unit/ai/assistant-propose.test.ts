/**
 * The assistant PREPARES a draft; it never writes — #2578 phase 2.
 *
 * The refusals are the subject. A draft is offered to a person as a prefilled
 * form, so one that the real route would refuse wastes their tap and their
 * trust — and an id the model invented would prefill a link to a record
 * nobody chose.
 */
import { proposeJournalEntry, PROPOSAL_KINDS } from '@/app-layer/ai/assistant/propose';

describe('proposeJournalEntry (#2578)', () => {
    it('prepares a valid draft, with no id anywhere in it', () => {
        const out = proposeJournalEntry({
            type: 'INPUT_APPLICATION',
            title: 'Пръскане на есенна пшеница',
            notes: 'Сутрин, при тихо време.',
            status: 'PLANNED',
        });
        expect(out.ok).toBe(true);
        expect(out.proposal?.kind).toBe('journal-entry');
        expect(out.proposal?.draft).toMatchObject({
            type: 'INPUT_APPLICATION',
            title: 'Пръскане на есенна пшеница',
        });
        // Nothing resembling a record reference — the person picks those.
        expect(JSON.stringify(out.proposal?.draft)).not.toMatch(/\bid\b|Ids?"/i);
        // And the message says plainly that nothing was saved.
        expect(out.message).toMatch(/nothing has been saved/i);
    });

    it('REFUSES an id the model invented, rather than stripping it silently', () => {
        // A silent strip would hand somebody a form missing the link they
        // asked for, with nothing saying so.
        for (const extra of [
            { locationIds: ['abc'] },
            { operationParcelId: 'p1' },
            { equipmentIds: ['e1'] },
            { harvest: { itemId: 'x' } },
        ]) {
            const out = proposeJournalEntry({ type: 'OBSERVATION', title: 'x', ...extra });
            expect(out.ok).toBe(false);
            expect(out.proposal).toBeNull();
            expect(out.message).toMatch(/Draft rejected/);
        }
    });

    it('refuses a type the PRODUCTION schema does not know', () => {
        // Refused by the same check the real route applies, rather than by a
        // copy of its value list that could drift.
        const out = proposeJournalEntry({ type: 'NOT_A_REAL_TYPE', title: 'x' });
        expect(out.ok).toBe(false);
        expect(out.message).toMatch(/would be refused by the journal API/);
    });

    it('refuses an empty or missing title — the real route requires one', () => {
        for (const args of [{ type: 'OBSERVATION' }, { type: 'OBSERVATION', title: '' }]) {
            expect(proposeJournalEntry(args).ok).toBe(false);
        }
    });

    it('never throws, whatever it is handed', () => {
        // The model supplies these. A throw would end a stream that has
        // already sent a 200.
        for (const junk of [null, undefined, 'x', 42, [], { type: 1, title: 2 }]) {
            expect(() => proposeJournalEntry(junk)).not.toThrow();
            expect(proposeJournalEntry(junk).ok).toBe(false);
        }
    });

    it('the kind set is closed', () => {
        expect([...PROPOSAL_KINDS]).toEqual(['journal-entry']);
    });
});

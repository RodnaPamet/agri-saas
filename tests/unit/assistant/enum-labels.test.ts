/**
 * The resolver itself, executed — the guard beside it only checks the
 * catalogue has the keys.
 */
import { enumLabel, assistantLocale } from '@/lib/assistant/enum-labels';

describe('enumLabel', () => {
    it('returns the farmer’s word, not the code', async () => {
        // The exact values the owner was shown as «Дейност (ACTIVITY)».
        expect(await enumLabel('logType', 'ACTIVITY', 'bg')).toBe('Дейност');
        expect(await enumLabel('logType', 'INPUT_APPLICATION', 'bg')).toBe('Внасяне на препарат');
        expect(await enumLabel('logStatus', 'DONE', 'bg')).not.toBe('DONE');
        expect(await enumLabel('operationParcelStatus', 'DONE', 'bg')).toBe('Готово');
    });

    it('resolves English for an English caller', async () => {
        const bg = await enumLabel('logType', 'ACTIVITY', 'bg');
        const en = await enumLabel('logType', 'ACTIVITY', 'en');
        expect(en).toBeTruthy();
        // The locale actually changes the answer — otherwise the parameter is
        // decoration and every caller gets one language by accident.
        expect(en).not.toBe(bg);
    });

    it('falls back to the RAW VALUE rather than throwing', async () => {
        // A missing label must degrade, not fail an answer. The guard is what
        // makes a missing label a CI failure; this is the runtime behaviour
        // when one slips through anyway.
        expect(await enumLabel('logType', 'NOT_A_REAL_MEMBER', 'bg')).toBe('NOT_A_REAL_MEMBER');
    });

    it('passes null through', async () => {
        expect(await enumLabel('logType', null, 'bg')).toBeNull();
        expect(await enumLabel('logType', undefined, 'bg')).toBeNull();
    });

    it('never returns a dotted catalogue path', async () => {
        // `translateFor` answers with the KEY when it cannot resolve. Printing
        // «journalEnums.logType.ACTIVITY» at a farmer is worse than printing
        // «ACTIVITY», so the resolver refuses to.
        for (const v of ['ACTIVITY', 'NOPE', 'HARVEST']) {
            expect(await enumLabel('logType', v, 'bg')).not.toContain('journalEnums');
        }
    });

    it('assistantLocale falls back to bg, never to the unauthenticated default', () => {
        expect(assistantLocale('en')).toBe('en');
        // `DEFAULT_LOCALE` is `en` and is documented for UNAUTHENTICATED
        // surfaces. An assistant caller is a known user whose column defaults
        // to bg, so a failed lookup must not hand them English.
        expect(assistantLocale(null)).toBe('bg');
        expect(assistantLocale(undefined)).toBe('bg');
    });
});

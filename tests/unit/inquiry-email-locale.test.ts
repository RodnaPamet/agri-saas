/**
 * The Exchange inquiry email speaks the RECIPIENT's language, and names the
 * commodity rather than its slug.
 *
 * Two defects, both live until now, both in the one Exchange channel that
 * crosses a tenant boundary — an email from the platform's own signed domain
 * into another tenant's owner/admin inbox.
 *
 *   1. **It was English-only.** `User.uiLanguage` exists and defaults to `bg`,
 *      and the seller-admin query already loaded the user row — the column was
 *      one `select` field away. The locale that matters is the RECIPIENT's,
 *      not the inquirer's: a request-scoped translator would have written the
 *      seller's email in the buyer's language.
 *
 *   2. **It rendered the raw commodity slug.** Since #484 the stored value is
 *      the canonical lowercase slug, so a seller read "New interest in your
 *      **wheat** listing". #677 fixed exactly this in the UI; the email path
 *      never got it, and the field's own docblock still claimed `e.g. "Wheat"`.
 *
 * Copy comes from the REAL message catalogues, so these assertions are
 * byte-identical to what a seller receives.
 */

const sendEmailMock = jest.fn();
class MockConsoleEmailProvider {}
let mockActiveProvider: unknown = {};

jest.mock('@/lib/mailer', () => ({
    sendEmail: (...a: unknown[]) => sendEmailMock(...a),
    ConsoleEmailProvider: MockConsoleEmailProvider,
    getEmailProvider: () => mockActiveProvider,
}));

import { sendInquiryEmail } from '@/lib/email/inquiry-email';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const EN = en.exchange.email as unknown as Record<string, string>;
const BG = bg.exchange.email as unknown as Record<string, string>;

type Sent = { to: string; subject: string; text: string; html: string };
const lastSend = (): Sent => sendEmailMock.mock.calls.at(-1)![0] as Sent;

beforeEach(() => {
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    mockActiveProvider = {};
});

const base = {
    to: 'seller@example.com',
    commodity: 'wheat',
    side: 'SELL' as const,
    message: 'Interested in 20t.',
    quantityTonnes: '20',
    inquiriesUrl: 'https://app.example/t/acme/exchange/my-listings',
};

describe('inquiry email — recipient locale', () => {
    it('writes the whole email in Bulgarian for a bg recipient', async () => {
        await sendInquiryEmail({ ...base, locale: 'bg' });
        const { subject, text, html } = lastSend();

        expect(subject).toBe(BG.subject.replace('{commodity}', 'Пшеница'));
        // The intro, quantity, message label and privacy line all switch.
        expect(text).toContain('Друго стопанство');
        expect(text).toContain(BG.messageLabel);
        expect(text).toContain('Количество');
        expect(html).toContain(BG.reviewLink);
        // …and no English survives in the body.
        expect(text).not.toContain('Another farm');
        expect(text).not.toContain('Quantity of interest');
    });

    it('writes it in English for an en recipient', async () => {
        await sendInquiryEmail({ ...base, locale: 'en' });
        const { subject, text } = lastSend();
        expect(subject).toBe(EN.subject.replace('{commodity}', 'Wheat'));
        expect(text).toContain('Another farm expressed interest');
        expect(text).not.toContain('Друго стопанство');
    });

    it('falls back to the default locale when none is given', async () => {
        // The prop is optional so the previous call shape stays valid. The
        // product default is bg, which is the point: omitting it must not
        // silently mean English.
        await sendInquiryEmail(base);
        expect(lastSend().text).toContain('Друго стопанство');
    });

    it('translates the side word, not just the sentence around it', async () => {
        await sendInquiryEmail({ ...base, side: 'BUY', locale: 'bg' });
        expect(lastSend().text).toContain(BG.sideBuy);
        expect(lastSend().text).not.toContain('BUY');

        await sendInquiryEmail({ ...base, side: 'SELL', locale: 'bg' });
        expect(lastSend().text).toContain(BG.sideSell);
    });
});

describe('inquiry email — commodity name, not slug', () => {
    it('names the commodity in the recipient language', async () => {
        await sendInquiryEmail({ ...base, commodity: 'sunflower', locale: 'bg' });
        const { subject, text } = lastSend();
        expect(subject).toContain('Слънчоглед');
        expect(text).toContain('Слънчоглед');
        // The regression: the raw slug must not reach the reader.
        expect(subject).not.toContain('sunflower');
        expect(text).not.toContain('sunflower');
    });

    it('handles a hyphenated slug', async () => {
        await sendInquiryEmail({ ...base, commodity: 'ammonium-nitrate', locale: 'bg' });
        expect(lastSend().text).toContain('Амониев нитрат');
        expect(lastSend().text).not.toContain('ammonium-nitrate');
    });

    it('title-cases a slug the catalogue does not know, never a key path', async () => {
        // `commodity` is a plain string column, so a row can hold a value in
        // no catalogue. `translateFor` returns the KEY PATH on a miss, and
        // putting `trends.commodities.triticale` in a seller's inbox would be
        // worse than the slug it replaced.
        await sendInquiryEmail({ ...base, commodity: 'triticale', locale: 'bg' });
        const { subject, text } = lastSend();
        expect(subject).toContain('Triticale');
        expect(text).not.toContain('trends.commodities');
    });
});

describe('inquiry email — escaping survived the rewrite', () => {
    it('still escapes the attacker-controlled message', async () => {
        // Every interpolation in this template was rewritten to use
        // translated strings. The escaping is the reason this email is safe
        // to deliver across a tenant boundary, so it is re-asserted here
        // rather than assumed to have come along for the ride.
        await sendInquiryEmail({
            ...base,
            message: '<img src=x onerror=alert(1)>',
            locale: 'bg',
        });
        const { html } = lastSend();
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });

    it('escapes the translated strings too', async () => {
        await sendInquiryEmail({ ...base, locale: 'bg' });
        const { html } = lastSend();
        // The privacy line contains an em dash; presence proves the
        // translated copy reached the HTML body at all.
        expect(html).toContain('—');
        expect(html).not.toContain('<script');
    });
});

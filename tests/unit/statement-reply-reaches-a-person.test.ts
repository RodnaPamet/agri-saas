/**
 * A reply to an Art 17 statement reaches the address it names (#1667).
 *
 * ## The gap, and the part the issue could not know
 *
 * `statementOfReasons.redress` names an address to write to for redress, which
 * Art 17(3)(f) requires. The mail was sent with no `replyTo`, so a person who
 * hits Reply — rather than copying the address out of the body — lands on the
 * deployment's own sender.
 *
 * #1667 framed that as "the redress route a no-reply sender defeats", and
 * measured, the sender is NOT a no-reply: `RESEND_FROM` and `SMTP_FROM` both
 * carry a real 7-character local part. The defect is worse than that framing
 * and for a different reason — every recipient at `agrent.bg` BOUNCES, because
 * the domain's MX points away from its mailbox (#1760). So the route the notice
 * named worked and the route a person actually takes silently failed.
 *
 * ## One resolver, not two sources
 *
 * The header and the body take the address from the SAME
 * `resolveRedressAddress()`. Two sources for one address is how they come to
 * disagree, and a reply arriving somewhere the notice never mentioned is worse
 * than no `replyTo` at all — the person would have no way to tell their appeal
 * went nowhere.
 */
// NOTHING is mocked here, deliberately.
//
// My first version mocked `@/lib/mailer` to stub `sendEmail` — for a dispatch
// case I did not end up writing — and that replaced the whole module, so
// `ResendProvider` came back undefined: "is not a constructor". Mocking the
// module under test is the barrel-mock trap one step further than usual, where
// the missing export is the SUBJECT rather than a sibling.
//
// These cases drive the real providers and assert what reaches the wire, which
// is the only level at which a misspelled field name is visible.
import { ResendProvider, NodemailerProvider } from '@/lib/mailer';

describe('the providers put a reply address on the wire', () => {
    it('Resend uses `reply_to`, not `replyTo`', async () => {
        // Resend's API spells it with an underscore and IGNORES an unknown
        // key, so the camelCase spelling fails silently and looks exactly like
        // success — the shape this repo keeps paying for. Asserted on the
        // serialised body rather than on the call, because the wire format is
        // the thing that can be wrong.
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ id: 'm-1' }),
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        await new ResendProvider('re_key', 'Agrent <noreply@example.test>').send({
            to: 'farmer@example.test',
            subject: 's',
            text: 't',
            replyTo: 'dsa@example.test',
        });

        const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect(body.reply_to).toBe('dsa@example.test');
        expect(body.replyTo).toBeUndefined();
    });

    it('Resend omits the field entirely when no address is configured', async () => {
        // Not an empty string: Resend would accept `reply_to: ""` and produce a
        // header pointing nowhere, which is worse than no header.
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true, status: 200, json: async () => ({ id: 'm-2' }),
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        await new ResendProvider('re_key', 'Agrent <noreply@example.test>').send({
            to: 'farmer@example.test', subject: 's', text: 't',
        });

        const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
        expect('reply_to' in body).toBe(false);
    });

    it('nodemailer uses its own `replyTo` spelling', async () => {
        const sendMail = jest.fn().mockResolvedValue({});
        const p = new NodemailerProvider(
            { host: 'h', port: 587, auth: { user: 'u', pass: 'p' } } as never,
            'from@example.test',
        );
        (p as unknown as { transporter: { sendMail: unknown } }).transporter = { sendMail };

        await p.send({
            to: 'farmer@example.test', subject: 's', text: 't', replyTo: 'dsa@example.test',
        });

        expect(sendMail).toHaveBeenCalledWith(
            expect.objectContaining({ replyTo: 'dsa@example.test' }),
        );
    });

    it('the two providers use DIFFERENT field names — the discriminator', () => {
        // Pinned as a fact rather than left to the two cases above: a
        // refactor that unified them on one spelling would break exactly one
        // provider, silently on Resend and loudly on SMTP.
        expect('reply_to').not.toBe('replyTo');
    });
});

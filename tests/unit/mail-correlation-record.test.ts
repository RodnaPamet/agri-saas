/**
 * The correlation row `sendEmail` writes, and the best-effort contract around
 * it (#1769).
 *
 * `StubEmailProvider` returns `Promise<void>`, so every other mailer test
 * drives `recordOutbound` straight into its `if (!messageId) return` — the
 * recorder is unreachable from the usual test provider. That matters more than
 * it sounds: the writer is wrapped in a catch that swallows, so a recorder
 * broken outright (a bad import, a renamed column) would log one line at
 * `warn` and look exactly like success. A test asserting only "nothing threw"
 * would pass against a recorder that records nothing.
 *
 * So the positive control comes first: a provider that mints an id, and the
 * ROW is asserted.
 */
import prisma from '@/lib/prisma';
import {
    StubEmailProvider,
    sendEmail,
    setEmailProvider,
    type EmailMessage,
    type EmailProvider,
} from '@/lib/mailer';

/** What `ResendProvider` does, minus the network: returns a message id. */
class IdMintingProvider implements EmailProvider {
    readonly sent: EmailMessage[] = [];
    constructor(private readonly id: string) {}
    async send(msg: EmailMessage): Promise<string | null> {
        this.sent.push(msg);
        return this.id;
    }
}

const PREFIX = `test-corr-${process.pid}-`;

afterAll(async () => {
    await prisma.outboundMessage.deleteMany({ where: { messageId: { startsWith: PREFIX } } });
});

describe('sendEmail records what sent the message', () => {
    it('writes the row, with a digest\'s FULL subject list', async () => {
        const messageId = `${PREFIX}digest`;
        setEmailProvider(new IdMintingProvider(messageId));

        await sendEmail({
            to: 'dsa@agrent.bg',
            subject: '3 notices waiting',
            text: 'body',
            purpose: 'notice-triage-alert',
            subjectType: 'ContentReport',
            subjectIds: ['rep_a', 'rep_b', 'rep_c'],
        });

        const row = await prisma.outboundMessage.findUnique({ where: { messageId } });
        expect(row).not.toBeNull();
        expect(row?.purpose).toBe('notice-triage-alert');
        expect(row?.subjectType).toBe('ContentReport');
        // All three. A scalar `subjectId` would have kept one and lost two,
        // which is the state #1769 calls worse than no correlation at all.
        expect(row?.subjectIds).toEqual(['rep_a', 'rep_b', 'rep_c']);
        expect(row?.recipientDomain).toBe('agrent.bg');
        // The webhook's to set, never this path's.
        expect(row?.failedAt).toBeNull();
        expect(row?.failureKind).toBeNull();
    });

    it('stores the recipient domain and never the address', async () => {
        const messageId = `${PREFIX}domain`;
        setEmailProvider(new IdMintingProvider(messageId));

        await sendEmail({
            to: 'ivan.petrov@example.com',
            subject: 'Reset',
            text: 'body',
            purpose: 'password-reset',
        });

        const row = await prisma.outboundMessage.findUnique({ where: { messageId } });
        expect(row?.recipientDomain).toBe('example.com');
        // Epic C.4: the local part is the part that names a person.
        expect(JSON.stringify(row)).not.toContain('ivan.petrov');
        // Nothing to correlate, and that is allowed to be empty rather than absent.
        expect(row?.subjectIds).toEqual([]);
        expect(row?.subjectType).toBeNull();
    });

    it('records nothing when the provider mints no id', async () => {
        const stub = new StubEmailProvider();
        setEmailProvider(stub);

        await sendEmail({ to: 'a@b.com', subject: 'S', text: 'B', purpose: 'mail-canary' });

        // The send happened; the row did not, because a message with no
        // provider id can never produce a webhook to look it up with.
        expect(stub.sentMessages).toHaveLength(1);
        const rows = await prisma.outboundMessage.findMany({
            where: { messageId: { startsWith: PREFIX } },
            select: { messageId: true },
        });
        expect(rows.map((r) => r.messageId)).not.toContain(`${PREFIX}canary`);
    });

    it('does not fail the send when the row cannot be written', async () => {
        // A REAL failure rather than a mocked one: `messageId` is unique, so
        // re-sending under an id already recorded makes the insert throw from
        // inside Prisma, which is the shape production would hit.
        const messageId = `${PREFIX}dupe`;
        const provider = new IdMintingProvider(messageId);
        setEmailProvider(provider);

        const once = { to: 'x@y.com', subject: 'S', text: 'B', purpose: 'invite' } as const;
        await sendEmail({ ...once });

        // The assertion that carries the ordering argument: `alertedAt` is
        // stamped only after `sendEmail` resolves, so a throw here would
        // un-stamp a digest that WAS delivered and send it twice. The row is
        // the expendable half, never the email.
        await expect(sendEmail({ ...once })).resolves.toBeUndefined();
        expect(provider.sent).toHaveLength(2);

        const rows = await prisma.outboundMessage.findMany({ where: { messageId } });
        expect(rows).toHaveLength(1);
    });
});

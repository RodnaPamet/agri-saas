/**
 * An Art 17 statement never promises a redress channel that does not exist
 * (#1667 ruling 2).
 *
 * ## Three wrong answers, in the order they were written
 *
 * 1. **"reply to this message and a person will look at it again."**
 *    `SMTP_FROM` defaults to `noreply@agrent.bg`. The promise was unhonoured
 *    in the one communication where a broken remedy is itself the compliance
 *    failure.
 *
 * 2. **"…through our contact page: /dsa-contact."** My first fix, and the
 *    ruling's literal wording. `agrent-ios` then read production: the page
 *    renders `dsa.addressUnset` — *"A contact address has not been configured
 *    for this deployment"* — because `DSA_CONTACT_EMAIL` is unset, under a
 *    heading that says "Write to the address below". So the route became
 *    **email → an empty page → the privacy notice**: a worse dead end than
 *    (1), about to be sent automatically on every suspension.
 *
 * 3. **Name an ADDRESS, or name none.** What is tested here.
 *
 * The lesson the tests encode: a redress line must be a function of what is
 * CONFIGURED, not of what a page is supposed to contain. A page can be empty;
 * an address either exists in the environment or does not.
 *
 * ## Why "name none" is the right third branch
 *
 * Art 17 requires informing the person of redress possibilities including
 * judicial redress. Out-of-court settlement and the courts exist regardless of
 * whether this deployment configured a mailbox, so the statement still informs
 * — it just stops claiming a human review channel it cannot route anyone to.
 */
import { composeStatementBody, resolveRedressAddress } from '@/app-layer/usecases/statement-body';

const ORIGINAL = {
    dsa: process.env.DSA_CONTACT_EMAIL,
    privacy: process.env.PRIVACY_CONTACT_EMAIL,
};

/**
 * `env` is validated once at import, so the module reads a frozen object.
 * Re-importing per case with `jest.resetModules()` is what makes the three
 * configurations reachable at all — without it every case would read whichever
 * value happened to be set when the suite loaded, and all three would pass
 * while testing one.
 */
async function withEnv(
    vars: { DSA_CONTACT_EMAIL?: string; PRIVACY_CONTACT_EMAIL?: string },
    fn: (m: typeof import('@/app-layer/usecases/statement-body')) => Promise<void>,
): Promise<void> {
    delete process.env.DSA_CONTACT_EMAIL;
    delete process.env.PRIVACY_CONTACT_EMAIL;
    Object.assign(process.env, vars);
    jest.resetModules();
    const mod = await import('@/app-layer/usecases/statement-body');
    try {
        await fn(mod);
    } finally {
        delete process.env.DSA_CONTACT_EMAIL;
        delete process.env.PRIVACY_CONTACT_EMAIL;
        if (ORIGINAL.dsa) process.env.DSA_CONTACT_EMAIL = ORIGINAL.dsa;
        if (ORIGINAL.privacy) process.env.PRIVACY_CONTACT_EMAIL = ORIGINAL.privacy;
        jest.resetModules();
    }
}

describe('the redress line names a real channel, or none (#1667)', () => {
    it('names DSA_CONTACT_EMAIL when it is set', async () => {
        await withEnv({ DSA_CONTACT_EMAIL: 'dsa@example.test' }, async (m) => {
            expect(m.resolveRedressAddress()).toBe('dsa@example.test');
            const { body } = await m.composeStatementBody('bg', 'ACCOUNT_SUSPENDED', 'причина');
            expect(body).toContain('dsa@example.test');
        });
    });

    it('falls back to PRIVACY_CONTACT_EMAIL — a real operator contact', async () => {
        await withEnv({ PRIVACY_CONTACT_EMAIL: 'privacy@example.test' }, async (m) => {
            expect(m.resolveRedressAddress()).toBe('privacy@example.test');
            const { body } = await m.composeStatementBody('bg', 'ACCOUNT_SUSPENDED', 'причина');
            expect(body).toContain('privacy@example.test');
        });
    });

    it('prefers the DSA address when BOTH are set', async () => {
        await withEnv(
            { DSA_CONTACT_EMAIL: 'dsa@example.test', PRIVACY_CONTACT_EMAIL: 'privacy@example.test' },
            async (m) => {
                const { body } = await m.composeStatementBody('bg', 'ACCOUNT_SUSPENDED', 'причина');
                expect(body).toContain('dsa@example.test');
                expect(body).not.toContain('privacy@example.test');
            },
        );
    });

    it('promises NO human review when neither is set, and still names the courts', async () => {
        // The branch that matters. This is production today.
        await withEnv({}, async (m) => {
            expect(m.resolveRedressAddress()).toBeNull();
            const { body } = await m.composeStatementBody('bg', 'ACCOUNT_SUSPENDED', 'причина');
            // Informs of judicial redress regardless — Art 17 requires it and
            // it is true whatever this deployment configured.
            expect(body).toMatch(/съда/);
            // And claims nothing it cannot route anyone to.
            expect(body).not.toMatch(/преразгледано от човек|пишете на/);
        });
    });

    it('NEVER points at a page, in ANY configuration', async () => {
        // The regression this file exists for. A page can render "not
        // configured"; an address cannot. Asserted across all three
        // configurations rather than the empty one, because the defect was
        // introduced in the configuration where the page DOES work.
        for (const vars of [
            { DSA_CONTACT_EMAIL: 'dsa@example.test' },
            { PRIVACY_CONTACT_EMAIL: 'privacy@example.test' },
            {},
        ]) {
            await withEnv(vars, async (m) => {
                const { body } = await m.composeStatementBody('bg', 'ACCOUNT_SUSPENDED', 'причина');
                expect(body).not.toContain('/dsa-contact');
                expect(body).not.toContain('/privacy');
                // And no unsubstituted placeholder, which would leave a legal
                // notice reading "write to {address}".
                expect(body).not.toMatch(/\{address\}|\{url\}/);
            });
        }
    });

    it('never tells anyone to reply to the message', async () => {
        // The first wrong answer. `SMTP_FROM` is a noreply mailbox.
        for (const vars of [{ DSA_CONTACT_EMAIL: 'dsa@example.test' }, {}]) {
            await withEnv(vars, async (m) => {
                for (const locale of ['bg', 'en'] as const) {
                    const { body } = await m.composeStatementBody(
                        locale, 'ACCOUNT_SUSPENDED', 'reason',
                    );
                    expect(body).not.toMatch(
                        /отговорете на това съобщение|reply to this message/i,
                    );
                }
            });
        }
    });

    it('the harness can actually change the answer — positive control', async () => {
        // `a-probe-with-no-discriminating-power`: `env` is frozen at import, so
        // without `jest.resetModules()` every case above would read one value
        // and all of them would pass while testing nothing.
        let a: string | null = 'unset';
        let b: string | null = 'unset';
        await withEnv({ DSA_CONTACT_EMAIL: 'a@example.test' }, async (m) => {
            a = m.resolveRedressAddress();
        });
        await withEnv({}, async (m) => {
            b = m.resolveRedressAddress();
        });
        expect(a).toBe('a@example.test');
        expect(b).toBeNull();
        expect(a).not.toBe(b);
    });
});

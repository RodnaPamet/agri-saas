/**
 * Unit test: the mailer WARNs when production falls back to the built-in
 * default sender (Roadmap-5 PR3). Deliverability suffers when the From address
 * isn't a domain the operator practices (SPF/DKIM), so prod must set
 * RESEND_FROM / SMTP_FROM explicitly.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('@/env', () => ({ env: {} as Record<string, unknown> }));

import { logger } from '@/lib/observability/logger';
import { env } from '@/env';
import { initMailerFromEnv } from '@/lib/mailer';

function setEnv(o: Record<string, unknown>): void {
    for (const k of Object.keys(env)) delete (env as Record<string, unknown>)[k];
    Object.assign(env, o);
}

describe('mailer default-sender production warning', () => {
    beforeEach(() => {
        (logger.warn as jest.Mock).mockClear();
    });

    it('WARNs in production when falling back to the built-in default sender', () => {
        setEnv({ NODE_ENV: 'production' }); // no RESEND_FROM / SMTP_FROM
        initMailerFromEnv();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringMatching(/default sender/i),
            expect.objectContaining({ component: 'mailer' }),
        );
    });

    it('does NOT warn when RESEND_FROM is set to an operator address', () => {
        setEnv({ NODE_ENV: 'production', RESEND_FROM: 'ops@agrent.bg' });
        initMailerFromEnv();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does NOT warn outside production', () => {
        setEnv({ NODE_ENV: 'development' });
        initMailerFromEnv();
        expect(logger.warn).not.toHaveBeenCalled();
    });
});

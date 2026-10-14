/**
 * @jest-environment jsdom
 *
 * `/no-tenant` renders the message that matches the person (#1738).
 *
 * The decision is unit-tested exhaustively in
 * `tests/unit/no-tenant-tells-the-truth.test.ts` — this asserts the DOM shows
 * the arm the decision picked, which is a different claim and the one a user
 * actually experiences.
 *
 * Real English copy, resolved from `messages/en.json`: a key-echo mock would
 * let the page render `noTenant.staleBody` and pass, while the wrong SENTENCE
 * is precisely the defect. `tests/rendered/setup.ts` does this project-wide for
 * `next-intl`, but this page imports `getTranslations` from
 * `next-intl/server`, which that setup does not cover — hence the local mock.
 *
 * Prisma is mocked rather than the helper, so the real
 * `accessGrantingTenantSlugs` + `slugsTheTokenDoesNotKnow` run and the test
 * covers the whole path from rows to sentence.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

import { setViewport } from './viewport';

const findMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenantMembership: { findMany: (args: unknown) => findMany(args) } },
}));

const authMock = jest.fn();
jest.mock('@/auth', () => ({
    auth: () => authMock(),
    signOut: jest.fn(),
}));

jest.mock('next-intl/server', () => {
    const en = require('../../messages/en.json');
    return {
        getTranslations: async (ns: string) => {
            const dict = (en as Record<string, Record<string, string>>)[ns] ?? {};
            const t = (key: string) => dict[key] ?? `${ns}.${key}`;
            // `t.rich` is used for `signedInAs`; the page only needs the text.
            (t as unknown as { rich: unknown }).rich = (
                key: string,
                vals: Record<string, unknown>,
            ) => (dict[key] ?? key).replace(/<b>|<\/b>/g, '').replace('{email}', String(vals.email));
            return t;
        },
    };
});

import NoTenantPage from '@/app/no-tenant/page';

const EN = require('../../messages/en.json').noTenant as Record<string, string>;

function signedInAs(id = 'u-1', memberships: Array<{ slug: string }> = []) {
    authMock.mockResolvedValue({
        user: { id, email: 'farmer@example.test', memberships },
    });
}

/** Rows shaped as `accessGrantingTenantSlugs` selects them. */
function dbGrants(...slugs: string[]) {
    findMany.mockResolvedValue(slugs.map((slug) => ({ tenant: { slug } })));
}

beforeEach(() => {
    authMock.mockReset();
    findMany.mockReset();
    setViewport('mobile');
});

async function renderPage() {
    render(await NoTenantPage());
}

describe.each(['mobile', 'desktop'] as const)('on %s', (viewport) => {
    beforeEach(() => setViewport(viewport));

    it('a farm creator is told their SESSION is stale, not to find an admin', async () => {
        // #1738 as hit on production: the OWNER membership exists, the token
        // predates it.
        signedInAs('u-1', []);
        dbGrants('agrent-platform-83605c04');

        await renderPage();

        expect(screen.getByTestId('no-tenant-body')).toHaveTextContent(EN.staleBody);
        expect(screen.getByText(EN.staleTitle)).toBeInTheDocument();
        // The sentence that sent the owner of a farm looking for an
        // administrator who does not exist.
        expect(screen.getByTestId('no-tenant-body')).not.toHaveTextContent(/admin/i);
    });

    it('someone with no farm at all still gets the original advice', async () => {
        // The control, and the reason the old copy stays: for this person
        // "ask your admin" is correct and "sign in again" would be a loop.
        signedInAs('u-2', []);
        dbGrants();

        await renderPage();

        expect(screen.getByTestId('no-tenant-body')).toHaveTextContent(EN.body);
        expect(screen.getByText(EN.title)).toBeInTheDocument();
        expect(screen.getByTestId('no-tenant-body')).toHaveTextContent(/admin/i);
    });

    it('the two arms render DIFFERENT text — the discriminator', async () => {
        // Asserted as a difference as well as two values. If the page rendered
        // one message for both inputs, each case above could still be made to
        // pass by a copy edit that collapsed them.
        signedInAs('u-3', []);
        dbGrants('alpha');
        await renderPage();
        const stale = screen.getByTestId('no-tenant-body').textContent;

        screen.getByTestId('no-tenant-body').remove();
        signedInAs('u-3', []);
        dbGrants();
        await renderPage();
        const plain = screen.getByTestId('no-tenant-body').textContent;

        expect(stale).not.toBe(plain);
    });
});

describe('it does not invent a diagnosis', () => {
    it('a token that already knows every farm gets the ORIGINAL message', async () => {
        // Reached by navigating here directly with a good session. Telling
        // this person their session is stale would be a diagnosis of a
        // problem they do not have.
        signedInAs('u-4', [{ slug: 'alpha' }]);
        dbGrants('alpha');

        await renderPage();

        expect(screen.getByTestId('no-tenant-body')).toHaveTextContent(EN.body);
    });

    it('the cross_tenant case — token has the old farms, not the new one', async () => {
        // The page's SECOND caller. `cross_tenant` redirects here too
        // (`src/middleware.ts`), and it was getting the same wrong advice.
        signedInAs('u-5', [{ slug: 'alpha' }, { slug: 'beta' }]);
        dbGrants('alpha', 'beta', 'gamma');

        await renderPage();

        expect(screen.getByTestId('no-tenant-body')).toHaveTextContent(EN.staleBody);
    });

    it('keeps the account link and the sign-out control on both arms', async () => {
        // P2.7 put the account link here because a membership-less user could
        // not otherwise reach their own settings, and sign-out is the remedy
        // the stale copy now tells them to use. A branch that dropped either
        // would strand the person the branch was added for.
        for (const grants of [['alpha'], []]) {
            signedInAs('u-6', []);
            dbGrants(...grants);
            const { unmount } = render(await NoTenantPage());
            expect(screen.getByTestId('no-tenant-account-link')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: EN.signOut })).toBeInTheDocument();
            unmount();
        }
    });
});

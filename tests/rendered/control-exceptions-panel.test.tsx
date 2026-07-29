/**
 * Epic G-5 — ControlExceptionsPanel render + interaction tests.
 *
 *   1. Empty state when no exceptions exist.
 *   2. Renders one row per exception with the right testid + badge.
 *   3. Header badge surfaces APPROVED state.
 *   4. canWrite gates the "Request exception" button.
 *   5. canAdmin gates Approve / Reject buttons on REQUESTED rows.
 *   6. Renew button only shows on APPROVED / EXPIRED rows.
 *   7. Request form requires justification + risk-acceptor before
 *      enabling submit.
 *   8. Reject dialog requires reason before submit.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/controls/c1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../../messages/en.json');
    const get = (p: string): unknown =>
        p.split('.').reduce<unknown>(
            (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
            en,
        );
    return {
        useTranslations:
            (ns?: string) =>
            (key: string, values?: Record<string, unknown>) => {
                const full = ns ? `${ns}.${key}` : key;
                const msg = get(full);
                if (typeof msg !== 'string') return full;
                return msg.replace(/\{(\w+)\}/g, (_, k) =>
                    values?.[k] != null ? String(values[k]) : `{${k}}`,
                );
            },
    };
});

import {
    ControlExceptionsPanel,
    ControlExceptionHeaderBadge,
} from '@/components/ControlExceptionsPanel';

function withClient(ui: React.ReactNode) {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function makeExceptionRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'cex_1',
        controlId: 'c1',
        status: 'REQUESTED' as const,
        expiresAt: null,
        approvedAt: null,
        rejectedAt: null,
        riskAcceptedByUserId: 'u_admin',
        createdByUserId: 'u_creator',
        createdAt: new Date('2026-04-30').toISOString(),
        renewedFromId: null,
        compensatingControlId: null,
        control: { id: 'c1', name: 'Affected', code: 'AC.1' },
        compensatingControl: null,
        ...overrides,
    };
}

/**
 * Route the component's raw `fetch`. GETs return the exception list; POSTs
 * (request / approve / reject / renew) return `post`, defaulting to success.
 * Returns the spy so a test can assert on the URL + body that went out.
 */
function installFetch(
    rows: unknown[],
    post: { ok?: boolean; text?: string } = {},
): jest.Mock {
    const fn = jest.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
            return {
                ok: post.ok ?? true,
                json: async () => ({ id: 'cex_new' }),
                text: async () => post.text ?? '',
            };
        }
        return { ok: true, json: async () => ({ rows }) };
    });
    (global as unknown as { fetch: jest.Mock }).fetch = fn;
    return fn;
}

const compensatingChoices = [
    { id: 'c2', name: 'Compensating', code: 'AC.2' },
];

describe('ControlExceptionsPanel', () => {
    it('renders empty state when no exceptions exist', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exceptions-empty');
    });

    it('renders one row per exception with the right testid', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_a', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_b',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_a');
        await screen.findByTestId('control-exception-row-cex_b');
    });

    it('header badge surfaces APPROVED state', async () => {
        installFetch([
            makeExceptionRow({
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        const badge = await screen.findByTestId(
            'control-exception-header-badge',
        );
        expect(badge.textContent).toMatch(/APPROVED/);
    });

    it('non-write actor cannot see the Request button', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite={false}
                    canAdmin={false}
                />,
            ),
        );
        await screen.findByTestId('control-exceptions-empty');
        expect(
            screen.queryByTestId('control-exception-request-button'),
        ).toBeNull();
    });

    it('approve / reject buttons only render for admins on REQUESTED rows', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_app',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        // Non-admin write user — no approve/reject buttons.
        const r1 = render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin={false}
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.queryByTestId('control-exception-approve-button-cex_req'),
        ).toBeNull();
        expect(
            screen.queryByTestId('control-exception-reject-button-cex_req'),
        ).toBeNull();
        r1.unmount();

        // Admin — buttons visible on REQUESTED, NOT on APPROVED.
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.getByTestId('control-exception-approve-button-cex_req'),
        ).toBeTruthy();
        expect(
            screen.queryByTestId('control-exception-approve-button-cex_app'),
        ).toBeNull();
    });

    it('renew button only renders on APPROVED or EXPIRED rows', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
            makeExceptionRow({
                id: 'cex_app',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
            makeExceptionRow({
                id: 'cex_exp',
                status: 'EXPIRED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2025-01-01').toISOString(),
            }),
            makeExceptionRow({
                id: 'cex_rej',
                status: 'REJECTED',
                rejectedAt: new Date().toISOString(),
            }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        await screen.findByTestId('control-exception-row-cex_req');
        expect(
            screen.queryByTestId('control-exception-renew-button-cex_req'),
        ).toBeNull();
        expect(
            screen.getByTestId('control-exception-renew-button-cex_app'),
        ).toBeTruthy();
        expect(
            screen.getByTestId('control-exception-renew-button-cex_exp'),
        ).toBeTruthy();
        expect(
            screen.queryByTestId('control-exception-renew-button-cex_rej'),
        ).toBeNull();
    });

    it('request form requires justification before submit is enabled', async () => {
        installFetch([]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('control-exception-request-button'),
        );
        const submit = (await screen.findByTestId(
            'exception-form-submit',
        )) as HTMLButtonElement;
        // Empty justification → disabled.
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: 'legacy system gap' },
        });
        expect(submit.disabled).toBe(false);
    });

    it('reject dialog requires reason before submit is enabled', async () => {
        installFetch([
            makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' }),
        ]);
        render(
            withClient(
                <ControlExceptionsPanel
                    tenantSlug="acme"
                    controlId="c1"
                    compensatingControlChoices={compensatingChoices}
                    defaultRiskAcceptedByUserId="u_admin"
                    canWrite
                    canAdmin
                />,
            ),
        );
        fireEvent.click(
            await screen.findByTestId('control-exception-reject-button-cex_req'),
        );
        const submit = (await screen.findByTestId(
            'exception-reject-submit',
        )) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
        fireEvent.change(screen.getByTestId('exception-reject-reason'), {
            target: { value: 'mitigation insufficient' },
        });
        expect(submit.disabled).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Mutation paths.
//
// Everything above stops at "is the button enabled?". The four dialogs
// each own a `useMutation` whose `mutationFn` builds the URL and the body,
// and whose `onSuccess` closes the dialog + invalidates the list. That is
// where an exception is actually granted, so it is the part that must be
// exercised, not just rendered. Each `it()` names the break it catches.
// ─────────────────────────────────────────────────────────────────────

const u = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 });

function renderPanel(
    over: Partial<React.ComponentProps<typeof ControlExceptionsPanel>> = {},
) {
    return render(
        withClient(
            <ControlExceptionsPanel
                tenantSlug="acme"
                controlId="c1"
                compensatingControlChoices={compensatingChoices}
                defaultRiskAcceptedByUserId="u_admin"
                canWrite
                canAdmin
                {...over}
            />,
        ),
    );
}

/** Resolve the control inside the FormField carrying `label`. */
function fieldByLabel(label: string): HTMLElement {
    const field = Array.from(
        document.querySelectorAll<HTMLElement>('[data-form-field="true"]'),
    ).find(
        (el) => el.querySelector('label')?.textContent?.replace(/\*/g, '').trim() === label,
    );
    if (!field) throw new Error(`No form field labelled "${label}"`);
    return field;
}

/** The POST calls that reached `fetch`, as `[url, parsedBody]` pairs. */
function postCalls(fetchSpy: jest.Mock): [string, Record<string, unknown>][] {
    return fetchSpy.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
        .map(([url, init]) => [
            url as string,
            JSON.parse((init as RequestInit).body as string),
        ]);
}

describe('ControlExceptionsPanel — requesting an exception', () => {
    it('posts the justification and OMITS the optional fields left untouched', async () => {
        // Break: sending `compensatingControlId: ''` / `expiresAt: ''` instead
        // of leaving them undefined ships an empty FK and an unparseable date
        // — the request 400s or, worse, stores a bogus link.
        const user = u();
        const fetchSpy = installFetch([]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-request-button'));
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: '  legacy system gap  ' },
        });
        await user.click(screen.getByTestId('exception-form-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        const [url, body] = postCalls(fetchSpy)[0];
        expect(url).toBe('/api/t/acme/controls/c1/exceptions');
        expect(body).toEqual({
            controlId: 'c1',
            justification: '  legacy system gap  ',
            riskAcceptedByUserId: 'u_admin',
        });
        // Success closes the dialog and re-reads the list.
        await waitFor(() => expect(screen.queryByTestId('exception-form-submit')).toBeNull());
        expect(fetchSpy.mock.calls.filter(([, i]) => !i).length).toBeGreaterThan(1);
    });

    it('offers every compensating control EXCEPT the one being excepted', async () => {
        // Break: dropping the `c.id !== controlId` filter lets a control be
        // named as its own compensating control — a self-referential waiver
        // that reads as mitigated to an auditor.
        const user = u();
        installFetch([]);
        renderPanel({
            compensatingControlChoices: [
                { id: 'c1', name: 'Affected', code: 'AC.1' },
                { id: 'c2', name: 'Compensating', code: 'AC.2' },
                { id: 'c3', name: 'Uncoded', code: null },
            ],
        });
        await user.click(await screen.findByTestId('control-exception-request-button'));
        await user.click(
            fieldByLabel('Compensating control (optional)').querySelector('[role="combobox"]')!,
        );

        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options).toEqual(['AC.2 — Compensating', 'Uncoded']);
    });

    it('attaches the chosen compensating control to the request', async () => {
        // Break: passing the option label instead of its id stores a
        // non-existent control reference.
        const user = u();
        const fetchSpy = installFetch([]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-request-button'));
        await user.click(
            fieldByLabel('Compensating control (optional)').querySelector('[role="combobox"]')!,
        );
        await user.click(await screen.findByRole('option', { name: 'AC.2 — Compensating' }));
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: 'legacy system gap' },
        });
        fireEvent.change(screen.getByTestId('exception-form-risk-acceptor'), {
            target: { value: 'u_ciso' },
        });
        await user.click(screen.getByTestId('exception-form-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        expect(postCalls(fetchSpy)[0][1]).toMatchObject({
            compensatingControlId: 'c2',
            riskAcceptedByUserId: 'u_ciso',
        });
    });

    it('shows the server’s reason and keeps the dialog open on rejection', async () => {
        // Break: closing on error would tell the requester the exception was
        // filed when it was not.
        const user = u();
        installFetch([], { ok: false, text: 'control already has an active exception' });
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-request-button'));
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: 'legacy system gap' },
        });
        await user.click(screen.getByTestId('exception-form-submit'));

        expect(await screen.findByTestId('exception-form-error')).toHaveTextContent(
            'control already has an active exception',
        );
        expect(screen.getByTestId('exception-form-submit')).toBeInTheDocument();
    });

    it('falls back to a readable message when the server body is empty', async () => {
        // Break: `new Error(text)` with an empty body renders a blank error
        // paragraph — a failure the operator cannot even see.
        const user = u();
        installFetch([], { ok: false, text: '' });
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-request-button'));
        fireEvent.change(screen.getByTestId('exception-form-justification'), {
            target: { value: 'legacy system gap' },
        });
        await user.click(screen.getByTestId('exception-form-submit'));

        expect(await screen.findByTestId('exception-form-error')).toHaveTextContent(
            'Failed to request exception',
        );
    });

    it('cancel closes the dialog without posting', async () => {
        const user = u();
        const fetchSpy = installFetch([]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-request-button'));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByTestId('exception-form-submit')).toBeNull());
        expect(postCalls(fetchSpy)).toHaveLength(0);
    });
});

describe('ControlExceptionsPanel — approving', () => {
    /** Open the approve dialog's DatePicker and commit a day in this month. */
    async function pickExpiry(user: ReturnType<typeof u>) {
        await user.click(fieldByLabel('Expires on').querySelector('button')!);
        const grid = await screen.findByRole('grid');
        await user.click(within(grid).getByText('15'));
    }

    it('refuses to approve without an expiry, then posts it as an ISO instant', async () => {
        // Break: an approval with no expiry is a permanent waiver; posting a
        // locale-formatted string instead of ISO makes the server store the
        // wrong day (or nothing).
        const user = u();
        const fetchSpy = installFetch([makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' })]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-approve-button-cex_req'));

        expect(screen.getByTestId('exception-approve-submit')).toBeDisabled();
        await pickExpiry(user);
        await waitFor(() =>
            expect(screen.getByTestId('exception-approve-submit')).not.toBeDisabled(),
        );
        fireEvent.change(screen.getByPlaceholderText('Conditions or scope of the approval'), {
            target: { value: 'scoped to the EU region' },
        });
        await user.click(screen.getByTestId('exception-approve-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        const [url, body] = postCalls(fetchSpy)[0];
        expect(url).toBe('/api/t/acme/controls/c1/exceptions/cex_req/approve');
        expect(body.note).toBe('scoped to the EU region');
        expect(String(body.expiresAt)).toMatch(/^\d{4}-\d{2}-15T/);
        await waitFor(() =>
            expect(screen.queryByTestId('exception-approve-submit')).toBeNull(),
        );
    });

    it('omits an untouched note rather than sending an empty string', async () => {
        // Break: an empty-string note pollutes the approval record with a
        // blank justification line in the audit export.
        const user = u();
        const fetchSpy = installFetch([makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' })]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-approve-button-cex_req'));
        await pickExpiry(user);
        await user.click(screen.getByTestId('exception-approve-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        expect(postCalls(fetchSpy)[0][1]).not.toHaveProperty('note');
    });

    it('surfaces an approval the server refuses', async () => {
        const user = u();
        installFetch([makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' })], {
            ok: false,
            text: 'expiry exceeds the policy maximum',
        });
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-approve-button-cex_req'));
        await pickExpiry(user);
        await user.click(screen.getByTestId('exception-approve-submit'));

        expect(await screen.findByTestId('exception-approve-error')).toHaveTextContent(
            'expiry exceeds the policy maximum',
        );
    });
});

describe('ControlExceptionsPanel — rejecting + renewing', () => {
    it('posts the reason to /reject and closes on success', async () => {
        // Break: hitting /approve here (a copy-paste of the sibling dialog)
        // would GRANT the exception the admin meant to refuse.
        const user = u();
        const fetchSpy = installFetch([makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' })]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-reject-button-cex_req'));
        fireEvent.change(screen.getByTestId('exception-reject-reason'), {
            target: { value: 'mitigation insufficient' },
        });
        await user.click(screen.getByTestId('exception-reject-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        expect(postCalls(fetchSpy)[0]).toEqual([
            '/api/t/acme/controls/c1/exceptions/cex_req/reject',
            { reason: 'mitigation insufficient' },
        ]);
        await waitFor(() => expect(screen.queryByTestId('exception-reject-submit')).toBeNull());
    });

    it('surfaces a refused rejection', async () => {
        const user = u();
        installFetch([makeExceptionRow({ id: 'cex_req', status: 'REQUESTED' })], {
            ok: false,
            text: 'exception is no longer REQUESTED',
        });
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-reject-button-cex_req'));
        fireEvent.change(screen.getByTestId('exception-reject-reason'), {
            target: { value: 'mitigation insufficient' },
        });
        await user.click(screen.getByTestId('exception-reject-submit'));

        expect(await screen.findByTestId('exception-reject-error')).toHaveTextContent(
            'exception is no longer REQUESTED',
        );
    });

    it('posts an empty body to /renew and closes on success', async () => {
        // Break: renewing against /approve would skip the admin approval the
        // renewal is required to go through.
        const user = u();
        const fetchSpy = installFetch([
            makeExceptionRow({
                id: 'cex_app',
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-renew-button-cex_app'));
        await user.click(screen.getByTestId('exception-renew-submit'));

        await waitFor(() => expect(postCalls(fetchSpy)).toHaveLength(1));
        expect(postCalls(fetchSpy)[0]).toEqual([
            '/api/t/acme/controls/c1/exceptions/cex_app/renew',
            {},
        ]);
        await waitFor(() => expect(screen.queryByTestId('exception-renew-submit')).toBeNull());
    });

    it('surfaces a refused renewal and keeps the dialog open', async () => {
        const user = u();
        installFetch(
            [
                makeExceptionRow({
                    id: 'cex_app',
                    status: 'APPROVED',
                    approvedAt: new Date().toISOString(),
                    expiresAt: new Date('2026-12-31').toISOString(),
                }),
            ],
            { ok: false, text: 'a renewal already exists' },
        );
        renderPanel();
        await user.click(await screen.findByTestId('control-exception-renew-button-cex_app'));
        await user.click(screen.getByTestId('exception-renew-submit'));

        expect(await screen.findByTestId('exception-renew-error')).toHaveTextContent(
            'a renewal already exists',
        );
        expect(screen.getByTestId('exception-renew-submit')).toBeInTheDocument();
    });
});

describe('ControlExceptionHeaderBadge — standalone export', () => {
    it('surfaces an active exception for the control-detail header', async () => {
        // Break: the badge is the only signal on the control header that the
        // control is knowingly not enforced — losing it hides the waiver.
        installFetch([
            makeExceptionRow({
                status: 'APPROVED',
                approvedAt: new Date().toISOString(),
                expiresAt: new Date('2026-12-31').toISOString(),
            }),
        ]);
        render(withClient(<ControlExceptionHeaderBadge tenantSlug="acme" controlId="c1" />));
        expect(await screen.findByTestId('control-exception-header-badge')).toHaveTextContent(
            'APPROVED',
        );
    });

    it('renders nothing when the only exception is rejected or expired', async () => {
        // Break: treating any row as "active" badges a control whose
        // exception was refused — the opposite of the truth.
        installFetch([
            makeExceptionRow({ id: 'cex_rej', status: 'REJECTED', rejectedAt: new Date().toISOString() }),
            makeExceptionRow({ id: 'cex_exp', status: 'EXPIRED' }),
        ]);
        const { container } = render(
            withClient(<ControlExceptionHeaderBadge tenantSlug="acme" controlId="c1" />),
        );
        await waitFor(() =>
            expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalled(),
        );
        expect(screen.queryByTestId('control-exception-header-badge')).toBeNull();
        expect(container).toBeEmptyDOMElement();
    });
});

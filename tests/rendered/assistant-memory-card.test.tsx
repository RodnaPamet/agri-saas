/**
 * «Какво помни асистентът» on the web (#2671).
 *
 * The two behaviours worth a test are the ones a reasonable implementation
 * gets wrong: what a flag-off person sees, and what somebody with nothing
 * remembered sees. Both are the COMMON case while this is dark.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';

const apiGet = jest.fn();
const apiDelete = jest.fn();
jest.mock('@/lib/api-client', () => ({
    apiGet: (...a: unknown[]) => apiGet(...a),
    apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

import { AssistantMemoryCard } from '@/app/account/profile/AssistantMemoryCard';
/*
 * EN, not BG. `tests/rendered/setup.ts` installs a project-wide `next-intl`
 * mock that resolves ENGLISH strings through ICU whatever the provider is
 * given — so a test asserting Bulgarian passes only by accident, or fails
 * confusingly as mine did. The Bulgarian copy's existence and parity are the
 * i18n gate's job (`i18n-diff.mjs --check`), not a rendered test's.
 */
import messages from '../../messages/en/app.json';

/*
 * A FRESH SWR cache per mount.
 *
 * SWR's default cache is module-scoped, so without this the empty `{facts:[]}`
 * from an earlier test in this file is served to a later one and the points
 * never appear — which looked like a rendering bug and is a cache hit.
 *
 * This is a TEST-only provider. `providers.tsx` mounts the app's single
 * `<SWRConfig provider>` and CLAUDE.md's "never add a second one" is about
 * that tree, not about isolating a unit test's cache.
 */
function mount(enabled: boolean) {
    return render(
        <SWRConfig value={{ provider: () => new Map() }}>
            <NextIntlClientProvider locale="en" messages={messages}>
                <AssistantMemoryCard enabled={enabled} />
            </NextIntlClientProvider>
        </SWRConfig>,
    );
}

beforeEach(() => {
    apiGet.mockReset();
    apiDelete.mockReset();
    apiGet.mockResolvedValue({ facts: [] });
});

describe('the flag-off person', () => {
    it('sees NOTHING — not a disabled card', async () => {
        const { container } = mount(false);
        // P5.3's rule: a disabled control advertises a feature that does not
        // exist. Absence is the only honest rendering of "off".
        expect(container).toBeEmptyDOMElement();
    });

    it('and the card does not even ASK', async () => {
        mount(false);
        // A fetch would make the OFF state observable in a network tab, and
        // would spend a request on an answer nobody can see.
        await waitFor(() => expect(apiGet).not.toHaveBeenCalled());
    });
});

describe('with the flag on and nothing remembered', () => {
    it('says so honestly rather than rendering an empty shell', async () => {
        mount(true);
        // The common case while the feature is dark, and while a new person
        // has said nothing durable. "Nothing remembered" is a true, calm
        // answer; a blank card reads as broken.
        expect(await screen.findByText(messages.account.assistantMemory.emptyTitle)).toBeInTheDocument();
    });

    it('offers no delete-everything when there is nothing to forget', async () => {
        mount(true);
        await screen.findByText(messages.account.assistantMemory.emptyTitle);
        expect(screen.queryByRole('button', { name: messages.account.assistantMemory.forgetAll })).toBeNull();
    });
});

describe('with points', () => {
    beforeEach(() => {
        apiGet.mockResolvedValue({
            facts: [
                { id: 'f1', text: 'Отглежда слънчоглед', rememberedAt: '2026-11-01T09:00:00.000Z' },
                { id: 'f2', text: 'Проблем с белите мухи', rememberedAt: '2026-11-01T10:00:00.000Z' },
            ],
        });
    });

    it('lists each point with its date, and offers a per-point delete', async () => {
        mount(true);
        expect(await screen.findByText('Отглежда слънчоглед')).toBeInTheDocument();
        expect(screen.getByText('Проблем с белите мухи')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: messages.account.assistantMemory.forget })).toHaveLength(2);
    });

    it('reads the PERSON-scoped endpoint, never a tenant one', async () => {
        mount(true);
        await screen.findByText('Отглежда слънчоглед');
        // A remembered point is about a person, across farms. A
        // `/api/t/{slug}/…` path would read zero rows with no error, because
        // the policies key on the person — the natural mistake in a product
        // where every other list is a farm's.
        expect(apiGet).toHaveBeenCalledWith('/api/account/assistant-memory');
    });
});

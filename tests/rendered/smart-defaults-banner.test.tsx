/** @jest-environment jsdom */
/**
 * SmartDefaultsBanner — the spray-window reasons MUST be translated at the UI
 * layer (regression: they used to render the server-generated English
 * `reasons[]` verbatim, so the Bulgarian app showed English subtitles). This
 * pins that the banner renders `reasonCodes` through `t(...)`, never the raw
 * English `reasons`.
 */
import { render, screen } from '@testing-library/react';

// Deterministic translator: echoes `spray:<key>` + interpolated params so the
// test can assert the translation path is used (and the raw English is NOT).
jest.mock('next-intl', () => ({
    // P2.1c — `useLocale` is part of this module and these mocks did not
    // provide it, so the first component to call it threw
    // "useLocale is not a function". The mock was incomplete relative to the
    // module, not wrong about this suite: `useDateFormat()` needs the active
    // locale, and a partial barrel mock turns a new dependency into a crash
    // across every suite that stubs it.
    useLocale: () => 'en',
    useTranslations: () => (key: string, params?: Record<string, unknown>) =>
        params && Object.keys(params).length
            ? `spray:${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`
            : `spray:${key}`,
}));

// P2.1c — stub the HOOK, not the module behind it. This mocked
// `@/lib/format-date` with a single `formatDate`, and the component now reaches
// it through `useDateFormat()`, so the partial mock threw
// "createDateFormatters is not a function". Stubbing what the component
// actually depends on is both smaller and accurate; a partial barrel mock
// turns any new export on that module into a crash here.
jest.mock('@/lib/i18n/use-date-format', () => ({
    useDateFormat: () => ({ formatDate: () => '2026-07-14' }),
}));

import { SmartDefaultsBanner } from '@/app/t/[tenantSlug]/(app)/locations/[locationId]/SmartDefaultsBanner';

describe('SmartDefaultsBanner spray reasons i18n', () => {
    it('renders reasonCodes through the translator, not the raw English reasons', () => {
        render(
            <SmartDefaultsBanner
                data={{
                    repeatLast: null,
                    byParcel: {},
                    defaultUnitId: null,
                    nextPlanting: null,
                    sprayWindow: {
                        status: 'CAUTION',
                        obsDate: '2026-07-14T00:00:00.000Z',
                        // English strings that must NOT appear in the DOM:
                        reasons: ['Wind 18.4 km/h — drift caution above 15 km/h'],
                        reasonCodes: [{ code: 'windCaution', params: { wind: 18.4, limit: 15 } }],
                        windows: [],
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any}
            />,
        );
        // Status + title use their own keys; the reason goes through t('sprayReason.windCaution').
        expect(screen.getByText(/spray:sprayReason\.windCaution\(wind=18\.4,limit=15\)/)).toBeInTheDocument();
        // The raw English reason string must never be rendered.
        expect(screen.queryByText(/drift caution above 15 km\/h/)).not.toBeInTheDocument();
    });

    it('renders the actual suitable time window(s) as HH:00–HH:00', () => {
        render(
            <SmartDefaultsBanner
                data={{
                    repeatLast: null,
                    byParcel: {},
                    defaultUnitId: null,
                    nextPlanting: null,
                    sprayWindow: {
                        status: 'GOOD',
                        obsDate: '2026-07-14T00:00:00.000Z',
                        reasons: [],
                        reasonCodes: [],
                        windows: [
                            { startHour: 6, endHour: 10 },
                            { startHour: 16, endHour: 19 },
                        ],
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any}
            />,
        );
        // Each window is formatted HH:00 and passed to t('sprayWindowRange').
        expect(screen.getByText(/spray:bestSprayWindow/)).toBeInTheDocument();
        expect(
            screen.getByText(/spray:sprayWindowRange\(from=06:00,to=10:00\).*spray:sprayWindowRange\(from=16:00,to=19:00\)/),
        ).toBeInTheDocument();
    });

    it('renders the "no window today" line when windows is empty', () => {
        render(
            <SmartDefaultsBanner
                data={{
                    repeatLast: null,
                    byParcel: {},
                    defaultUnitId: null,
                    nextPlanting: null,
                    sprayWindow: {
                        status: 'UNSUITABLE',
                        obsDate: '2026-07-14T00:00:00.000Z',
                        reasons: [],
                        reasonCodes: [],
                        windows: [],
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any}
            />,
        );
        expect(screen.getByText(/spray:sprayNoWindowToday/)).toBeInTheDocument();
        expect(screen.queryByText(/spray:bestSprayWindow/)).not.toBeInTheDocument();
    });

    it('renders nothing when there is no spray window and no planting', () => {
        const { container } = render(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <SmartDefaultsBanner data={{ sprayWindow: null, nextPlanting: null } as any} />,
        );
        expect(container).toBeEmptyDOMElement();
    });
});

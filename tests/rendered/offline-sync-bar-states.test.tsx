/**
 * @jest-environment jsdom
 *
 * The three states of the sync bar — the copy an operator actually reads.
 *
 * ## Why a rendered test and not a guard
 *
 * The defect this feature exists for was NOT a missing mechanism. The outbox
 * queued, drained and retried correctly the whole time. What was wrong was
 * that the bar said the same thing — nothing — whether the work had reached
 * the server or the phone had deleted it, and no structural assertion about
 * `src/components/offline/OfflineSyncBar.tsx` can catch a rendering that is
 * technically present and semantically empty. Only reading the output can.
 *
 * Viewport: this suite deliberately inherits the project-wide PHONE default
 * (`tests/rendered/setup.ts` answers `matches: false` to every media query).
 * The bar has no responsive branch, so the default is the real device and
 * there is nothing to override.
 */
import { render, screen } from '@testing-library/react';
import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';

// Real English copy, with the one ICU form these keys use evaluated — the
// point of the test is the string an operator sees, so a mock that echoed
// key names would assert nothing.
jest.mock('next-intl', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) => {
            const msg = key
                .split('.')
                .reduce<unknown>(
                    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
                    (en as Record<string, unknown>)[ns],
                );
            if (typeof msg !== 'string') return `${ns}.${key}`;
            const plural = msg.match(
                /^\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}$/,
            );
            const body = plural
                ? (Number(values?.[plural[1]]) === 1 ? plural[2] : plural[3]).replace(
                      /#/g,
                      String(values?.[plural[1]] ?? ''),
                  )
                : msg;
            return body.replace(/\{(\w+)\}/g, (_, k) =>
                values?.[k] != null ? String(values[k]) : `{${k}}`,
            );
        },
    };
});

const noop = () => {};

describe('OfflineSyncBar — where is the work?', () => {
    it('queued work says it is on the PHONE and not on the server', () => {
        render(<OfflineSyncBar online pending={2} onSyncNow={noop} />);
        expect(screen.getByTestId('offline-pending-count')).toHaveTextContent(
            '2 changes saved on this phone',
        );
        expect(screen.getByTestId('offline-location-claim')).toHaveTextContent(
            'Not on the server yet',
        );
    });

    it('an empty queue says the server HAS it — the claim is never left implicit', () => {
        // The regression: silence used to mean both "delivered" and "deleted".
        render(<OfflineSyncBar online pending={0} onSyncNow={noop} />);
        expect(screen.getByTestId('offline-location-claim')).toHaveTextContent(
            'Everything is on the server',
        );
        expect(screen.queryByTestId('offline-pending-count')).not.toBeInTheDocument();
    });

    it('reads singular at one item, because one is the common case in a field', () => {
        render(<OfflineSyncBar online pending={1} onSyncNow={noop} />);
        expect(screen.getByTestId('offline-pending-count')).toHaveTextContent(
            '1 change saved on this phone',
        );
    });

    it('counts photos separately — they read differently to an operator', () => {
        render(<OfflineSyncBar online pending={3} pendingPhotos={1} onSyncNow={noop} />);
        expect(screen.getByTestId('offline-pending-count')).toHaveTextContent(
            '2 changes saved on this phone',
        );
        expect(screen.getByTestId('offline-pending-photos')).toHaveTextContent(
            '1 photo saved on this phone',
        );
    });

    it('offers "Sync now" only when there is work AND a network to send it over', () => {
        const { rerender } = render(<OfflineSyncBar online={false} pending={2} onSyncNow={noop} />);
        expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
        rerender(<OfflineSyncBar online pending={2} onSyncNow={noop} />);
        expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
        rerender(<OfflineSyncBar online pending={0} onSyncNow={noop} />);
        expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    });

    it('warns once the queue has grown past routine', () => {
        const { rerender } = render(<OfflineSyncBar online pending={4} onSyncNow={noop} />);
        expect(screen.queryByTestId('offline-queue-growing')).not.toBeInTheDocument();
        rerender(<OfflineSyncBar online pending={20} queueGrowing onSyncNow={noop} />);
        expect(screen.getByTestId('offline-queue-growing')).toHaveTextContent('Get to signal soon');
    });

    describe('the storage-durability caution', () => {
        it('appears when the phone REFUSED to protect queued work', () => {
            render(<OfflineSyncBar online pending={2} storagePersisted={false} onSyncNow={noop} />);
            expect(screen.getByTestId('offline-storage-unprotected')).toBeInTheDocument();
        });

        it('stays quiet when the phone granted persistence', () => {
            render(<OfflineSyncBar online pending={2} storagePersisted onSyncNow={noop} />);
            expect(screen.queryByTestId('offline-storage-unprotected')).not.toBeInTheDocument();
        });

        it('stays quiet when nothing is queued — there is nothing at risk', () => {
            render(<OfflineSyncBar online pending={0} storagePersisted={false} onSyncNow={noop} />);
            expect(screen.queryByTestId('offline-storage-unprotected')).not.toBeInTheDocument();
        });

        it('stays quiet when the browser never reported — silence is not a refusal', () => {
            render(<OfflineSyncBar online pending={2} storagePersisted={null} onSyncNow={noop} />);
            expect(screen.queryByTestId('offline-storage-unprotected')).not.toBeInTheDocument();
        });
    });
});

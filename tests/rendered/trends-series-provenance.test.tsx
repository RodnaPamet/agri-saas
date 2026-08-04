/**
 * `SeriesProvenance` — the component that stops a price being anonymous.
 *
 * The backend computes source, stage, currency and observation date honestly;
 * the UI used to drop all of them, so an official EU quote and the median of
 * three neighbours' ASKING prices on our own noticeboard rendered
 * pixel-identically under the same "Market trends" heading. These tests assert
 * the DOM a farmer actually reads — the project-wide next-intl mock resolves
 * real `messages/en.json` strings, so what is asserted here is what ships.
 *
 * The negative assertions matter most. "Does it render a label" is easy to
 * keep passing; "can an asking price ever read as a market quote" is the
 * question that costs money if it regresses.
 */
import { render, screen } from '@testing-library/react';

import { SeriesProvenance } from '@/components/trends/SeriesProvenance';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    SOURCE_BARCHART,
    SOURCE_EC,
    SOURCE_LISTINGS,
    STALE_AFTER_DAYS,
} from '@/components/trends/trends-helpers';

const GENERATED_AT = '2026-03-20T09:00:00.000Z';

/** yyyy-mm-dd, `n` days before GENERATED_AT. */
const daysBefore = (n: number) =>
    new Date(Date.UTC(2026, 2, 20) - n * 86_400_000).toISOString().slice(0, 10);

function renderProvenance(
    series: { source: string; stage?: string | null; lastObservedAt?: string | null },
    props: { hideSource?: boolean } = {},
) {
    // `in` rather than `??` — an EXPLICIT null means "never reported", which is
    // a different case from "the test didn't care" and must not be defaulted.
    const lastObservedAt =
        'lastObservedAt' in series ? (series.lastObservedAt ?? null) : daysBefore(3);
    return render(
        // The app mounts one TooltipProvider in providers.tsx; the disclosure
        // hints are InfoTooltips, so the tree needs it here too.
        <TooltipProvider>
            <SeriesProvenance
                series={{
                    source: series.source,
                    stage: series.stage ?? null,
                    lastObservedAt,
                }}
                generatedAt={GENERATED_AT}
                {...props}
            />
        </TooltipProvider>,
    );
}

describe('SeriesProvenance — source', () => {
    it('names the EC series as official prices', () => {
        renderProvenance({ source: SOURCE_EC });
        expect(screen.getByText('Official prices (EC)')).toBeInTheDocument();
    });

    it('calls the listings index asking prices on Agrent, never a market quote', () => {
        renderProvenance({ source: SOURCE_LISTINGS });

        expect(screen.getByText('Asking prices on Agrent')).toBeInTheDocument();
        // The generic "Listings index" wording reads like an index someone
        // computed FOR a market rather than offers posted on our own board.
        expect(screen.queryByText('Listings index')).not.toBeInTheDocument();
        expect(screen.queryByText('Official prices (EC)')).not.toBeInTheDocument();
    });

    it('names Barchart as futures rather than "Other source"', () => {
        renderProvenance({ source: SOURCE_BARCHART });
        expect(screen.getByText('Futures (delayed)')).toBeInTheDocument();
        expect(screen.queryByText('Other source')).not.toBeInTheDocument();
    });

    it('omits the source when the caller already labels it', () => {
        renderProvenance({ source: SOURCE_EC }, { hideSource: true });
        expect(screen.queryByText('Official prices (EC)')).not.toBeInTheDocument();
        // The date survives — hiding the source must not hide the age.
        expect(screen.getByText(/as of/i)).toBeInTheDocument();
    });
});

describe('SeriesProvenance — disclosure', () => {
    it('discloses the delay on exchange data', () => {
        // Not cosmetic: redistributing Euronext data requires an EMDA licence,
        // for which delay disclosure is a standard term.
        renderProvenance({ source: SOURCE_BARCHART });
        expect(screen.getByText('Delayed quote')).toBeInTheDocument();
    });

    it('does not label an official EU quote as delayed', () => {
        renderProvenance({ source: SOURCE_EC });
        expect(screen.queryByText('Delayed quote')).not.toBeInTheDocument();
    });

    it('names the market stage, because ex-farm and delivered-to-port differ', () => {
        renderProvenance({ source: SOURCE_EC, stage: 'FGATE' });
        expect(screen.getByText('Stage: FGATE')).toBeInTheDocument();
    });
});

describe('SeriesProvenance — freshness', () => {
    it('shows "as of" for a recent observation', () => {
        renderProvenance({ source: SOURCE_EC, lastObservedAt: daysBefore(2) });
        expect(screen.getByText(/^as of /i)).toBeInTheDocument();
        expect(screen.queryByText(/not updated since/i)).not.toBeInTheDocument();
    });

    it('warns instead of reassuring once a series stops reporting', () => {
        renderProvenance({
            source: SOURCE_EC,
            lastObservedAt: daysBefore(STALE_AFTER_DAYS + 5),
        });
        expect(screen.getByText(/not updated since/i)).toBeInTheDocument();
        expect(screen.queryByText(/^as of /i)).not.toBeInTheDocument();
    });

    it('tolerates a single late weekly publication', () => {
        // A warning that fires whenever the feed slips a day is a warning
        // nobody reads.
        renderProvenance({ source: SOURCE_EC, lastObservedAt: daysBefore(8) });
        expect(screen.getByText(/^as of /i)).toBeInTheDocument();
    });

    it('says nothing about age when the series never reported', () => {
        renderProvenance({ source: SOURCE_EC, lastObservedAt: null });
        expect(screen.queryByText(/as of/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/not updated since/i)).not.toBeInTheDocument();
    });
});

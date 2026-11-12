'use client';

/**
 * «Потвърждаване на стопанства» — the review queue (#2963).
 *
 * ## There is no «Одобри» button, and that is the design
 *
 * `verifyFarmClaim` takes *"the ЕИК the reviewer found in the register. Never
 * read from the row."* The claim stores `eikHash` and no endpoint returns a
 * number, so the reviewer looks the farm up in the commercial register
 * independently and types what they find; the server checks it against the
 * hash.
 *
 * A one-click approve would let somebody promote a claim without doing the
 * lookup, which is the single thing that input shape exists to prevent. So the
 * control on each row is an ЕИК FIELD. #2963 as filed called the evidence
 * question open — it was answered in P3.4, and this is what the answer looks
 * like on a screen.
 *
 * ## The seven outcomes are not two
 *
 * `VerifyOutcome` has seven members and a reviewer has to tell at least three
 * of them apart:
 *
 *   - `EIK_MISMATCH` — the number does not match what this farm claimed. Their
 *     problem or a typo; re-check and try again.
 *   - `DISPUTED_COLLISION` — another farm already holds a VERIFIED claim on
 *     this ЕИК, and THIS claim is now DISPUTED. Not a typo, not retryable, and
 *     it needs a human decision between two farms.
 *   - `EIK_INVALID` — the checksum fails, so it was refused before any lookup.
 *     Nothing was touched.
 *
 * Collapsing those into "could not verify" would make a two-farm collision
 * look like a mistyped digit, which is the one confusion with a wrong remedy
 * attached.
 *
 * `ALREADY_VERIFIED` is a SUCCESS, not an error: the usecase is idempotent and
 * a double submit must not read as a failure.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Heading } from '@/components/ui/typography';
import { apiPost } from '@/lib/api-client';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { formatDate } from '@/lib/format-date';

interface ClaimWire {
    id: string;
    tenantId: string;
    tenantName: string | null;
    tenantSlug: string | null;
    status: 'PENDING' | 'VERIFIED' | 'DISPUTED';
    claimedByUserId: string;
    createdAt: string;
    verifiedAt: string | null;
    disputedAt: string | null;
}

type Outcome =
    | 'VERIFIED' | 'ALREADY_VERIFIED' | 'EIK_MISMATCH' | 'EIK_INVALID'
    | 'NOT_FOUND' | 'DISPUTED_COLLISION' | 'ALREADY_DISPUTED'
    // From `dispute`, not from `verify`.
    | 'DISPUTED';

/**
 * Which outcomes are a success for the reviewer, not an error.
 *
 * `ALREADY_VERIFIED` is in here because the usecase is idempotent and a double
 * submit must not read as a failure. `DISPUTED` is in here because refusing a
 * claim IS the reviewer succeeding at the thing they set out to do — rendering
 * it as a warning would make the refusal path feel like a malfunction, which
 * is the same bias the missing control created.
 */
const SUCCEEDED: ReadonlySet<Outcome> = new Set<Outcome>([
    'VERIFIED', 'ALREADY_VERIFIED', 'DISPUTED',
]);

/** The three reachable statuses, in queue-then-resolved order. */
const STATUS_OPTIONS: readonly ClaimWire['status'][] = ['PENDING', 'VERIFIED', 'DISPUTED'];

const STATUS_TONE: Record<ClaimWire['status'], 'warning' | 'success' | 'error'> = {
    PENDING: 'warning',
    VERIFIED: 'success',
    DISPUTED: 'error',
};

export function FarmClaimsReviewClient({ tenantSlug }: { tenantSlug: string }) {
    const t = useTranslations('farmClaims');
    const url = useTenantApiUrl();

    const [status, setStatus] = React.useState<ClaimWire['status']>('PENDING');
    const { data, error, isLoading, mutate } = useTenantSWR<{ claims: ClaimWire[] }>(
        `/admin/farm-claims?status=${status}`,
    );

    const [eik, setEik] = React.useState<Record<string, string>>({});
    const [reason, setReason] = React.useState<Record<string, string>>({});
    // Which claim's dispute form is OPEN. One at a time, and closed by
    // default: a reason box sitting beside every ЕИК field would present
    // refusal as the equally-likely option on every row, and most claims are
    // ordinary.
    const [disputing, setDisputing] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<string | null>(null);
    const [outcome, setOutcome] = React.useState<{ id: string; result: Outcome } | null>(null);

    const claims = data?.claims ?? [];

    const submit = React.useCallback(
        async (claimId: string) => {
            const typed = (eik[claimId] ?? '').trim();
            if (!typed) return;
            setBusy(claimId);
            setOutcome(null);
            try {
                // The server answers a non-2xx for five of the seven outcomes,
                // so the result is read from the THROWN error's body as well
                // as from a success. A reviewer who typed a mismatching number
                // needs to be told which of the five it was, not that "the
                // request failed".
                const res = await apiPost<{ result: Outcome }>(
                    url(`/admin/farm-claims/${encodeURIComponent(claimId)}/verify`),
                    { eik: typed },
                );
                setOutcome({ id: claimId, result: res.result });
                if (SUCCEEDED.has(res.result)) {
                    setEik((prev) => ({ ...prev, [claimId]: '' }));
                    await mutate();
                }
            } catch (err) {
                const result = (err as { body?: { result?: Outcome } })?.body?.result;
                setOutcome({ id: claimId, result: result ?? 'NOT_FOUND' });
                // REVALIDATED even on a refusal, because `DISPUTED_COLLISION`
                // CHANGES this claim's status to DISPUTED — the row the
                // reviewer is looking at is now stale, and a queue that still
                // showed it as PENDING would invite a second attempt that
                // cannot succeed.
                if (result === 'DISPUTED_COLLISION') await mutate();
            } finally {
                setBusy(null);
            }
        },
        [eik, mutate, url],
    );

    const dispute = React.useCallback(
        async (claimId: string) => {
            const why = (reason[claimId] ?? '').trim();
            if (!why) return;
            setBusy(claimId);
            setOutcome(null);
            try {
                const res = await apiPost<{ result: Outcome }>(
                    url(`/admin/farm-claims/${encodeURIComponent(claimId)}/dispute`),
                    { reason: why },
                );
                setOutcome({ id: claimId, result: res.result });
                if (res.result === 'DISPUTED') {
                    setDisputing(null);
                    setReason((prev) => ({ ...prev, [claimId]: '' }));
                    await mutate();
                }
            } catch (err) {
                const result = (err as { body?: { result?: Outcome } })?.body?.result;
                setOutcome({ id: claimId, result: result ?? 'NOT_FOUND' });
            } finally {
                setBusy(null);
            }
        },
        [reason, mutate, url],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('breadcrumbAdmin'), href: `/t/${tenantSlug}/admin` },
                        { label: t('breadcrumbCurrent') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1}>{t('title')}</Heading>
                {/*
                  * The instruction is the screen's whole point: the reviewer
                  * must look the farm up themselves. Without it the ЕИК field
                  * reads as a confirmation step for a number they are expected
                  * to have been shown somewhere.
                  */}
                <InlineNotice variant="info">{t('howToVerify')}</InlineNotice>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <div className="min-h-0 flex-1 space-y-default overflow-y-auto pr-1">
                    {/*
                      * `<ToggleGroup>`, not three buttons. Epic 60's rule is
                      * explicit — never hand-roll a segmented filter row —
                      * and my first draft did, with the active one as
                      * `variant="primary"`. `primary-action-budget` caught it,
                      * correctly: a screen with five primary buttons has no
                      * primary action, and a filter is a selection rather
                      * than an action at all.
                      */}
                    <ToggleGroup
                        options={STATUS_OPTIONS.map((value) => ({
                            value,
                            label: t(`status.${value}`),
                        }))}
                        selected={status}
                        selectAction={(value) => setStatus(value as ClaimWire['status'])}
                        ariaLabel={t('filterAria')}
                    />

                    {error ? (
                        <ErrorState description={t('loadError')} onRetry={() => void mutate()} />
                    ) : isLoading && claims.length === 0 ? (
                        <div className="space-y-default" aria-busy="true">
                            {[0, 1].map((i) => (
                                <Skeleton key={i} className="h-24 w-full rounded-lg" />
                            ))}
                        </div>
                    ) : claims.length === 0 ? (
                        <EmptyState variant="no-records" title={t(`empty.${status}`)} />
                    ) : (
                        claims.map((c) => (
                            <div
                                key={c.id}
                                className="space-y-default rounded-lg border border-border-subtle p-4"
                            >
                                <div className="flex items-center gap-default">
                                    <span className="font-medium text-content-emphasis">
                                        {/*
                                          * A deleted tenant leaves the claim
                                          * behind — `tenantName` is nullable
                                          * for exactly that — and a blank row
                                          * would read as a rendering fault.
                                          */}
                                        {c.tenantName ?? t('tenantGone')}
                                    </span>
                                    <StatusBadge variant={STATUS_TONE[c.status]}>
                                        {t(`status.${c.status}`)}
                                    </StatusBadge>
                                    <span className="text-xs text-content-muted">
                                        {t('claimedOn', { date: formatDate(c.createdAt) })}
                                    </span>
                                </div>
                                <p className="text-xs text-content-muted">
                                    {t('slug')}: {c.tenantSlug ?? '—'}
                                </p>

                                {c.status === 'PENDING' ? (
                                    <div className="flex items-end gap-tight">
                                        {/*
                                          * `<FormField>`, not a hand-written
                                          * <label>. Epic 55's rule is to wrap
                                          * every field with it, and
                                          * `formfield-coverage` budgets raw
                                          * labels for exactly this reason. My
                                          * first draft reasoned that one
                                          * field in a row was "lighter" than
                                          * the wrapper — which is how a
                                          * budget gets spent one justified
                                          * exception at a time.
                                          */}
                                        <div className="flex-1">
                                            <FormField label={t('eikLabel')}>
                                                <Input
                                                    id={`eik-${c.id}`}
                                                    value={eik[c.id] ?? ''}
                                                    onChange={(e) =>
                                                        setEik((prev) => ({
                                                            ...prev,
                                                            [c.id]: e.target.value,
                                                        }))
                                                    }
                                                    inputMode="numeric"
                                                    autoComplete="off"
                                                />
                                            </FormField>
                                        </div>
                                        <Button
                                            variant="primary"
                                            onClick={() => void submit(c.id)}
                                            disabled={busy === c.id || !(eik[c.id] ?? '').trim()}
                                        >
                                            {t('verify')}
                                        </Button>
                                        {/*
                                          * SECONDARY, and it opens a form
                                          * rather than acting. The refusal
                                          * path must be no harder than the
                                          * approval path — the usecase's own
                                          * argument for not requiring an ЕИК
                                          * here — but it still asks for a
                                          * reason, because both this and the
                                          * collision case leave `status =
                                          * DISPUTED` and the row cannot
                                          * otherwise say which happened.
                                          */}
                                        <Button
                                            variant="secondary"
                                            onClick={() =>
                                                setDisputing((prev) =>
                                                    prev === c.id ? null : c.id,
                                                )
                                            }
                                            disabled={busy === c.id}
                                        >
                                            {t('dispute')}
                                        </Button>
                                    </div>
                                ) : null}

                                {c.status === 'PENDING' && disputing === c.id ? (
                                    <div className="space-y-tight rounded-lg border border-border-subtle p-4">
                                        <FormField
                                            label={t('reasonLabel')}
                                            description={t('reasonNotShown')}
                                        >
                                            <Input
                                                id={`reason-${c.id}`}
                                                value={reason[c.id] ?? ''}
                                                onChange={(e) =>
                                                    setReason((prev) => ({
                                                        ...prev,
                                                        [c.id]: e.target.value,
                                                    }))
                                                }
                                                autoComplete="off"
                                            />
                                        </FormField>
                                        {/*
                                          * «Not shown to the farm» rides the
                                          * FormField's `description` rather
                                          * than a loose <p>: it is helper
                                          * text for that field, and the
                                          * primitive ties it to the input for
                                          * a screen reader, which a sibling
                                          * paragraph does not.
                                          */}
                                        <Button
                                            variant="primary"
                                            onClick={() => void dispute(c.id)}
                                            disabled={busy === c.id || !(reason[c.id] ?? '').trim()}
                                        >
                                            {t('confirmDispute')}
                                        </Button>
                                    </div>
                                ) : null}

                                {outcome && outcome.id === c.id ? (
                                    <InlineNotice
                                        variant={
                                            SUCCEEDED.has(outcome.result) ? 'success' : 'warning'
                                        }
                                    >
                                        {t(`outcome.${outcome.result}`)}
                                    </InlineNotice>
                                ) : null}
                            </div>
                        ))
                    )}
                </div>
            </ListPageShell.Body>
        </ListPageShell>
    );
}

'use client';
/**
 * «Сигнализирай» — the DSA Art 16 notice form (P5.3, #1594).
 *
 * ## One dialog for every subject kind
 *
 * It takes `{ subjectKind, subjectId }` rather than existing in three
 * variants, because the form is identical whatever is being reported: a reason
 * from a closed list and optional free text. Three dialogs would be three
 * places for the reason list to drift, and the reason list is the one thing a
 * regulator may ask about.
 *
 * The entry points differ — a listing has a page, a message is a row, a thread
 * is a header — so those are thin triggers (`ReportButton`) and this is the
 * form they all open.
 *
 * ## It is not behind a feature flag
 *
 * Filing a notice is a legal duty, so `POST /api/social/reports` is in
 * `FLAG_EXEMPT` and this dialog is always available. The person-BLOCK control
 * beside it is a product feature and is gated. That difference is deliberate
 * and is the seam P5.2 was split along.
 *
 * ## The reason list is a Combobox, not a native select
 *
 * `epic55-native-select-ratchet` caps native `<select>` and may only go down.
 * `MISLEADING_LISTING` carries a hint under its label — "the grade, quantity,
 * origin or certification is wrong" — because it is the agricultural case a
 * generic category list would miss, and the bare label does not say that.
 *
 * ## What it does NOT promise
 *
 * No wording here says the reported party is told, or that anything will be
 * removed. The notice is acknowledged and the outcome appears under the
 * reporter's own notices; `GET /api/social/reports` is what makes that
 * possible, and it exists because `content_report_reporter_read` was added for
 * it.
 */
import { useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { apiPost } from '@/lib/api-client';
import { REPORT_DETAIL_MAX, REPORT_REASON_CODES } from '@/lib/schemas';

export type ReportSubjectKind = 'LISTING' | 'MESSAGE' | 'PROFILE' | 'THREAD';

export interface ReportDialogProps {
    open: boolean;
    /**
     * `Dispatch<SetStateAction<boolean>>`, not `(v: boolean) => void` — the
     * Modal primitive passes an updater function through, so the narrower
     * signature does not satisfy it.
     */
    setOpen: Dispatch<SetStateAction<boolean>>;
    subjectKind: ReportSubjectKind;
    subjectId: string;
}

export function ReportDialog({ open, setOpen, subjectKind, subjectId }: ReportDialogProps) {
    const t = useTranslations('trustSafety.report');
    const [reason, setReason] = useState<string | null>(null);
    const [detail, setDetail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    // Derived from the shared constant, so a reason added to the API contract
    // cannot be missing from the form — the kind of drift a hand-listed array
    // here would make invisible.
    const options = REPORT_REASON_CODES.map((code) => ({
        value: code,
        label:
            code === 'MISLEADING_LISTING'
                ? `${t(`reason.${code}`)} — ${t('reason.MISLEADING_LISTING_HINT')}`
                : t(`reason.${code}`),
    }));

    function dismiss() {
        setOpen(false);
        reset();
    }

    function reset() {
        setReason(null);
        setDetail('');
        setError(null);
        setSent(false);
        setBusy(false);
    }

    async function submit() {
        if (!reason || busy) return;
        setBusy(true);
        setError(null);
        try {
            // The LITERAL path, not `useTenantApiUrl()`.
            //
            // Every other call in the exchange code around this builds
            // `/api/t/{tenantSlug}/…`, and reaching for that helper here would
            // be the natural mistake. These routes are deliberately NOT
            // tenant-scoped: `content_report_reporter_read` matches on
            // `app.user_id`, which only `runInUserContext` sets, so a tenant
            // route would read ZERO rows with no error (#1593).
            await apiPost('/api/social/reports', {
                subjectKind,
                subjectId,
                reasonCode: reason,
                // Empty stays empty rather than becoming `''`: the server
                // sanitises and stores NULL for "nothing written", and the two
                // are the same fact to a moderator.
                detail: detail.trim() ? detail.trim() : null,
            });
            setSent(true);
        } catch {
            // One message for every cause, deliberately. A notifier cannot act
            // on the difference between a 400 and a 500, and the route answers
            // a uniform `invalid_request` anyway so there is no detail to show.
            setError(t('failed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            showModal={open}
            setShowModal={(next) => {
                setOpen(next);
                // `next` may be an updater, so the close-reset keys off the
                // CURRENT state rather than trying to read the new value.
                if (open) reset();
            }}
        >
            <Modal.Header title={sent ? t('sent') : t('title')} />
            <Modal.Body>
                {sent ? (
                    <p className="text-sm text-content-subtle">{t('sentBody')}</p>
                ) : (
                    <div className="flex flex-col gap-default">
                        <p className="text-sm text-content-subtle">{t('intro')}</p>

                        <FormField label={t('reasonLabel')} required>
                            <Combobox
                                id="report-reason"
                                name="reasonCode"
                                options={options}
                                selected={options.find((o) => o.value === reason) ?? null}
                                setSelected={(opt) => setReason(opt ? opt.value : null)}
                                placeholder={t('reasonPlaceholder')}
                                searchPlaceholder={t('reasonPlaceholder')}
                            />
                        </FormField>

                        <FormField label={t('detailLabel')} description={t('detailHint')}>
                            <Textarea
                                id="report-detail"
                                name="detail"
                                value={detail}
                                maxLength={REPORT_DETAIL_MAX}
                                placeholder={t('detailPlaceholder')}
                                onChange={(e) => setDetail(e.target.value)}
                            />
                        </FormField>

                        {error ? (
                            <p role="alert" className="text-sm text-content-error">
                                {error}
                            </p>
                        ) : null}
                    </div>
                )}
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    {/* ONE primary, not one per state.
                        `primary-action-budget` counts them statically and caps
                        this file at 1 — correctly, even though the submit and
                        the post-success dismiss never render together: a
                        reader cannot tell mutually exclusive primaries from
                        duplicated ones, and nor can the guard. Collapsing them
                        is less code than raising the budget and does not spend
                        a ratchet. */}
                    {!sent ? (
                        <Button variant="secondary" onClick={dismiss}>
                            {t('cancel')}
                        </Button>
                    ) : null}
                    <Button
                        variant="primary"
                        // A reason is required; detail is not. Art 16 does not
                        // let us refuse a notice for want of prose, so only
                        // the reason gates submission.
                        disabled={!sent && (!reason || busy)}
                        onClick={() => {
                            if (sent) dismiss();
                            else void submit();
                        }}
                    >
                        {sent ? t('close') : busy ? t('sending') : t('submit')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

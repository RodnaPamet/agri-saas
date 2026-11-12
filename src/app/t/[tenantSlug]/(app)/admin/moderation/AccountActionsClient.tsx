'use client';

/**
 * Reversing a decision, and suspending or reinstating an account — #2735, PR 3.
 *
 * ## Why these two sit together and apart from the queue
 *
 * The notices queue above is about deciding a notice. These are acts on things
 * ALREADY decided: a reversal of a content removal, and a measure against a
 * person. P5.1 kept `subjectKind: 'ACCOUNT'` separate from the content kinds so
 * that "somebody reported this profile" and "we suspended this account" are not
 * one query, and a console that collapsed them would undo that distinction in
 * the UI.
 *
 * ## The id is PASTED, and that is an owner ruling (2026-11-12)
 *
 * There is deliberately NO people lookup and no action search. A platform-wide
 * search by name or email would be the first surface in this product where one
 * person can enumerate every account — its own decision with its own review,
 * not a convenience folded into a console. The common case already has the id:
 * the queue above shows `subjectId`, and a restore needs the `actionId` the
 * decision returned.
 *
 * It is ugly and it is honest about being ugly. A form that looked friendlier
 * by guessing the account from a notice would be re-deciding the judgement P5.1
 * left to a human: a notice names CONTENT, and a reported listing belongs to a
 * farm whose members are several.
 *
 * ## Suspending and lifting are NOT symmetric, and the form says so
 *
 * A suspension requires a reason — it is the rationale the Art 17 statement is
 * composed from, and a decision that withholds a farm from a person is not
 * recordable without one. Lifting requires none: restoring the ability to sign
 * in is not a decision that machinery composes a statement from. So the reason
 * field belongs to the suspend action alone rather than to the section.
 *
 * ## What lifting does NOT do, stated where the operator can read it
 *
 * It does not return revoked sessions, and it does not cancel an erasure the
 * person requested themselves. An operator who believes otherwise will tell
 * somebody their account is fully restored when it is not, which is why the
 * copy says it rather than the docblock alone.
 */
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';
import { apiDelete, apiPost } from '@/lib/api-client';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

type Outcome =
    | { kind: 'ok'; message: string }
    | { kind: 'warn'; message: string }
    | { kind: 'error'; message: string }
    | null;

function codeOf(err: unknown): string {
    return err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
}

export function AccountActionsClient() {
    const t = useTranslations('moderationQueue');
    const apiUrl = useTenantApiUrl();

    const [actionId, setActionId] = React.useState('');
    const [restoreReason, setRestoreReason] = React.useState('');
    const [restoreBusy, setRestoreBusy] = React.useState(false);
    const [restoreOut, setRestoreOut] = React.useState<Outcome>(null);

    const [userId, setUserId] = React.useState('');
    const [suspendReason, setSuspendReason] = React.useState('');
    const [acctBusy, setAcctBusy] = React.useState(false);
    const [acctOut, setAcctOut] = React.useState<Outcome>(null);

    async function restore() {
        setRestoreBusy(true);
        setRestoreOut(null);
        try {
            const res = await apiPost<{ restored: boolean }>(
                `${apiUrl}/admin/moderation/restore`,
                { actionId: actionId.trim(), rationale: restoreReason.trim() },
            );
            // `restored: false` is a SUCCESS — the content was already visible.
            // Reporting it as a failure would make a double submit look broken.
            setRestoreOut(
                res?.restored
                    ? { kind: 'ok', message: t('restore.done') }
                    : { kind: 'warn', message: t('restore.alreadyVisible') },
            );
            setActionId('');
            setRestoreReason('');
        } catch (err) {
            setRestoreOut({
                kind: 'error',
                message: codeOf(err) === 'MODERATION_ACTION_NOT_FOUND'
                    ? t('restore.notFound')
                    : t('restore.failed'),
            });
        } finally {
            setRestoreBusy(false);
        }
    }

    async function suspend() {
        setAcctBusy(true);
        setAcctOut(null);
        try {
            const res = await apiPost<{ alreadySuspended: boolean }>(
                `${apiUrl}/admin/moderation/suspensions`,
                { userId: userId.trim(), reason: suspendReason.trim() },
            );
            setAcctOut(
                res?.alreadySuspended
                    ? { kind: 'warn', message: t('suspend.already') }
                    : { kind: 'ok', message: t('suspend.done') },
            );
            setSuspendReason('');
        } catch (err) {
            setAcctOut({
                kind: 'error',
                message: codeOf(err) === 'ACCOUNT_NOT_FOUND'
                    ? t('suspend.notFound')
                    : t('suspend.failed'),
            });
        } finally {
            setAcctBusy(false);
        }
    }

    async function lift() {
        setAcctBusy(true);
        setAcctOut(null);
        try {
            // A BODY, not a path or query parameter: iOS logs the full URL
            // unsuppressably, and a third party's user id in a device log is
            // the disclosure P5.2b exists to prevent.
            //
            // `apiDelete(url, init)` takes a RequestInit rather than a body, so
            // the payload and its content-type go through `init` — the
            // `BlockPersonButton` precedent, which is the other route in this
            // product reading a JSON body on DELETE for the same reason.
            //
            // It also returns `Promise<void>`, so the client CANNOT read
            // `wasSuspended` back. One success message therefore covers both
            // "was suspended, now lifted" and "was not suspended anyway" —
            // stated rather than papered over, because the alternative is
            // asserting a distinction this call cannot observe. The audit chain
            // carries it. An account that does not exist is a 404 and is
            // reported separately below.
            await apiDelete(`${apiUrl}/admin/moderation/suspensions`, {
                body: JSON.stringify({ userId: userId.trim() }),
                headers: { 'content-type': 'application/json' },
            });
            setAcctOut({ kind: 'ok', message: t('lift.done') });
        } catch (err) {
            setAcctOut({
                kind: 'error',
                message: codeOf(err) === 'ACCOUNT_NOT_FOUND'
                    ? t('suspend.notFound')
                    : t('lift.failed'),
            });
        } finally {
            setAcctBusy(false);
        }
    }

    const canRestore = actionId.trim().length > 0 && restoreReason.trim().length > 0;
    const canSuspend = userId.trim().length > 0 && suspendReason.trim().length > 0;
    const canLift = userId.trim().length > 0;

    function notice(o: Outcome) {
        if (!o) return null;
        return (
            <InlineNotice variant={o.kind === 'ok' ? 'success' : o.kind === 'warn' ? 'warning' : 'error'}>
                {o.message}
            </InlineNotice>
        );
    }

    return (
        <div className="space-y-section">
            <div className="rounded-lg border border-border-subtle p-default space-y-default">
                <Heading level={2}>{t('restore.title')}</Heading>
                <p className="text-content-muted">{t('restore.intro')}</p>

                <FormField label={t('restore.actionIdLabel')} hint={t('restore.actionIdHint')} required>
                    <Input value={actionId} onChange={(e) => setActionId(e.target.value)} />
                </FormField>
                <FormField label={t('restore.reasonLabel')} hint={t('restore.reasonHint')} required>
                    <Textarea
                        value={restoreReason}
                        onChange={(e) => setRestoreReason(e.target.value)}
                        rows={3}
                    />
                </FormField>
                {notice(restoreOut)}
                <Button variant="primary" disabled={restoreBusy || !canRestore} onClick={restore}>
                    {t('restore.submit')}
                </Button>
            </div>

            <div className="rounded-lg border border-border-subtle p-default space-y-default">
                <Heading level={2}>{t('suspend.title')}</Heading>
                <p className="text-content-muted">{t('suspend.intro')}</p>

                <FormField label={t('suspend.userIdLabel')} hint={t('suspend.userIdHint')} required>
                    <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
                </FormField>
                <FormField label={t('suspend.reasonLabel')} hint={t('suspend.reasonHint')}>
                    <Textarea
                        value={suspendReason}
                        onChange={(e) => setSuspendReason(e.target.value)}
                        rows={3}
                    />
                </FormField>
                {notice(acctOut)}
                {/*
                  * Two buttons, and the REASON gates only one of them. Lifting
                  * needs none — see the docblock — so a shared disabled state
                  * would make reinstatement impossible without inventing a
                  * rationale for it.
                  */}
                <div className="flex flex-wrap gap-tight">
                    <Button variant="destructive" disabled={acctBusy || !canSuspend} onClick={suspend}>
                        {t('suspend.submit')}
                    </Button>
                    <Button variant="secondary" disabled={acctBusy || !canLift} onClick={lift}>
                        {t('lift.submit')}
                    </Button>
                </div>
                <p className="text-content-muted">{t('lift.caveat')}</p>
            </div>
        </div>
    );
}

'use client';
/**
 * «Блокирай потребителя» — the PERSON block (P5.3, #1594).
 *
 * ## It must not be confused with the exchange block, and they sit side by side
 *
 * The thread header can show both, and they behave in opposite ways. This is
 * the single most confusable thing in P5, so the distinction is in the copy
 * rather than left to the reader:
 *
 *                      exchange block                 THIS
 *   control            «Блокирай купувача»            «Блокирай потребителя»
 *   who may press it   the seller only                either person
 *   the other party    IS TOLD — they see             is told NOTHING; the
 *                      «Този продавач не приема       conversation disappears
 *                      съобщения от Вас.»             from their side
 *
 * Both are correct and the owner confirmed both. The exchange refusal is
 * commercial and a buyer is entitled to understand it; a social block must
 * reveal nothing.
 *
 * So this dialog says, in `blockPerson.notTold`, that they are not told — and
 * says it to the BLOCKER, who is the only person who can read it. Concealing a
 * person's own action from themselves would be the wrong kind of silence, and
 * "nothing visibly happened" is the worst version of it.
 *
 * `blockPerson.distinctFromExchange` is the other half: a seller pressing this
 * on a thread needs to know it is not the same control as refusing a buyer on
 * one of their listings.
 *
 * ## Gated, unlike the report button next to it
 *
 * Blocking is a product feature and an Apple 1.2 requirement, so it gates on
 * `social.person-blocks`. Filing a notice is a legal duty and does not.
 *
 * The flag is resolved on the SERVER and passed in as `enabled` — there is no
 * client-side flags hook in this codebase, and inventing one here would be a
 * second source of truth for a kill switch. With the flag off this renders
 * nothing, and the route refuses independently (defence in depth): a client
 * that kept the button would still get a 404.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { apiDelete, apiPost } from '@/lib/api-client';

export interface BlockPersonButtonProps {
    /** The person to block. Never the caller — the API refuses a self-block. */
    blockedUserId: string;
    /** Whether `social.person-blocks` is on, resolved server-side. */
    enabled: boolean;
    /** Whether this person is already blocked, so the control can lift it. */
    blocked?: boolean;
    onChanged?: () => void;
}

export function BlockPersonButton({
    blockedUserId,
    enabled,
    blocked = false,
    onChanged,
}: BlockPersonButtonProps) {
    const t = useTranslations('trustSafety.blockPerson');
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // With the flag off there is no control at all. Not a disabled button: a
    // disabled control advertises a feature that does not exist yet, which is
    // the opposite of a dark launch.
    if (!enabled) return null;

    async function act() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            // The LITERAL path, not `useTenantApiUrl()`. A person block has no
            // tenant: `UserBlock`'s policies key on `app.user_id`, which only
            // `runInUserContext` sets, so a tenant-scoped route could not
            // serve this (#1593).
            //
            // DELETE carries the id in the BODY rather than the path, because
            // iOS logs the full URL unsuppressably and a third party's user id
            // in a device log is the disclosure this phase exists to prevent.
            if (blocked) {
                // `apiDelete(url, init)` takes a RequestInit, not a body, so
                // the payload and its content-type go through `init`. The
                // route reads a JSON body on DELETE for the logging reason
                // above, which is unusual enough that it is worth seeing here.
                await apiDelete('/api/social/blocks', {
                    body: JSON.stringify({ blockedUserId }),
                    headers: { 'content-type': 'application/json' },
                });
            } else {
                await apiPost('/api/social/blocks', { blockedUserId });
            }
            setOpen(false);
            onChanged?.();
        } catch {
            setError(t('failed'));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
                {blocked ? t('unblockTrigger') : t('trigger')}
            </Button>
            <Modal showModal={open} setShowModal={setOpen}>
                <Modal.Header title={t('title')} />
                <Modal.Body>
                    <div className="flex flex-col gap-tight">
                        <p className="text-sm text-content-default">{t('body')}</p>
                        {/* Said to the BLOCKER, the only person who can read
                            it. The silence is towards the person blocked, not
                            towards the one doing it. */}
                        <p className="text-sm text-content-subtle">{t('notTold')}</p>
                        <p className="text-sm text-content-subtle">
                            {t('distinctFromExchange')}
                        </p>
                        {error ? (
                            <p role="alert" className="text-sm text-content-error">
                                {error}
                            </p>
                        ) : null}
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Modal.Actions>
                        <Button variant="secondary" onClick={() => setOpen(false)}>
                            {t('cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            disabled={busy}
                            onClick={() => {
                                void act();
                            }}
                        >
                            {t('confirm')}
                        </Button>
                    </Modal.Actions>
                </Modal.Footer>
            </Modal>
        </>
    );
}

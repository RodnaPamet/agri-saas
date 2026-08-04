'use client';

/**
 * Interests editor modal (News → For You).
 *
 * A chip editor over the user's interest keywords: removable chips + an add box
 * (Enter or the Add button). Save PUT-replaces the whole set at
 * `/me/interests` and hands the normalized result back via `onSaved`; Cancel
 * discards the draft. Keywords are normalized (trim + lowercase) client-side too
 * so the chips read as they'll be stored — the server normalizes again.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Xmark } from '@/components/ui/icons/nucleo/xmark';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

/** Keep in lockstep with MAX_INTERESTS in the usecase. */
const MAX_INTERESTS = 20;

export function InterestsModal({
    open,
    onClose,
    initial,
    onSaved,
}: {
    open: boolean;
    onClose: () => void;
    initial: string[];
    onSaved: (keywords: string[]) => void;
}) {
    const t = useTranslations('trends');
    const buildApiUrl = useTenantApiUrl();
    const [draft, setDraft] = useState<string[]>(initial);
    const [input, setInput] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Reseed the draft from the latest saved set each time the modal opens.
    useEffect(() => {
        if (open) {
            setDraft(initial);
            setInput('');
            setError(null);
        }
    }, [open, initial]);

    const addKeyword = () => {
        const k = input.trim().toLowerCase();
        setInput('');
        if (!k || draft.includes(k) || draft.length >= MAX_INTERESTS) return;
        setDraft((d) => [...d, k]);
    };
    const removeKeyword = (k: string) => setDraft((d) => d.filter((x) => x !== k));

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(buildApiUrl('/me/interests'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keywords: draft }),
            });
            // `onClose()` used to sit OUTSIDE this branch, with no catch: a
            // failed save closed the modal exactly like a success, and the
            // user's edits vanished with no way to tell. On a rural
            // connection that is the common case, not the edge case.
            if (!res.ok) {
                setError(t('news.forYou.saveFailed'));
                return;
            }
            const json = (await res.json().catch(() => ({}))) as { keywords?: string[] };
            onSaved(json.keywords ?? draft);
            onClose();
        } catch {
            // Network failure — the modal STAYS OPEN holding the draft, so
            // retrying costs a click rather than retyping everything.
            setError(t('news.forYou.saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={(v) => {
                if (!v) onClose();
            }}
            title={t('news.forYou.modalTitle')}
        >
            <Modal.Header title={t('news.forYou.modalTitle')} />
            <Modal.Body>
                <div className="space-y-default">
                    <div className="flex items-start gap-tight">
                        <div className="flex-1">
                            <Input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addKeyword();
                                    }
                                }}
                                placeholder={t('news.forYou.addPlaceholder')}
                                aria-label={t('news.forYou.addAria')}
                                maxLength={50}
                            />
                        </div>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={addKeyword}
                            disabled={!input.trim() || draft.length >= MAX_INTERESTS}
                        >
                            {t('news.forYou.add')}
                        </Button>
                    </div>

                    {draft.length === 0 ? (
                        <p className="text-xs text-content-subtle">{t('news.forYou.emptyDraft')}</p>
                    ) : (
                        <ul className="flex flex-wrap gap-tight" aria-label={t('news.forYou.chipsAria')}>
                            {draft.map((k) => (
                                <li key={k}>
                                    <span className="inline-flex items-center gap-1 rounded-full bg-bg-subtle py-1 pl-3 pr-1.5 text-xs text-content-default">
                                        {k}
                                        <button
                                            type="button"
                                            onClick={() => removeKeyword(k)}
                                            aria-label={t('news.forYou.removeChip', { keyword: k })}
                                            className="flex h-5 w-5 items-center justify-center rounded-full text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                                        >
                                            <Xmark width={12} height={12} aria-hidden="true" />
                                        </button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {error && (
                    <p role="alert" className="mt-default text-xs text-content-error">
                        {error}
                    </p>
                )}
            </Modal.Body>
            <Modal.Actions>
                <Button type="button" variant="secondary" onClick={onClose}>
                    {t('news.forYou.cancel')}
                </Button>
                <Button type="button" variant="primary" onClick={save} loading={saving}>
                    {t('news.forYou.save')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}

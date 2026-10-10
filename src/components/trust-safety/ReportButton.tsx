'use client';
/**
 * «Сигнализирай» — the thin trigger that opens `ReportDialog` (P5.3, #1594).
 *
 * Deliberately thin. Three surfaces open the same form — a listing, a message
 * row, a thread header — and they differ only in where the button sits and how
 * loud it is, so the variation lives in props rather than in three components
 * with three copies of the reason list.
 *
 * `subjectKind` is not inferred from the route. A message and the thread that
 * contains it are reported from the same screen, and a component that guessed
 * from the URL would report one as the other — which a moderator would have no
 * way to tell apart, because the snapshot is captured from whatever
 * `subjectId` names.
 *
 * NOT flag-gated: filing a notice is a DSA Art 16 legal duty. The person-block
 * control beside it IS gated, and `BlockPersonButton` carries that difference.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { ReportDialog, type ReportSubjectKind } from './ReportDialog';

export interface ReportButtonProps {
    subjectKind: ReportSubjectKind;
    subjectId: string;
    /**
     * `ghost` for a message row, where a visible button on every line would
     * shout; `secondary` for a header or a listing, where it is one of a small
     * set of deliberate actions.
     */
    variant?: 'ghost' | 'secondary';
    size?: 'xs' | 'sm' | 'md';
    /** Icon-only presentations still need a name for a screen reader. */
    labelled?: boolean;
}

export function ReportButton({
    subjectKind,
    subjectId,
    variant = 'secondary',
    size = 'sm',
    labelled = true,
}: ReportButtonProps) {
    const t = useTranslations('trustSafety.report');
    const [open, setOpen] = useState(false);

    return (
        <>
            <Button
                variant={variant}
                size={size}
                aria-label={labelled ? undefined : t('triggerAria')}
                onClick={() => setOpen(true)}
            >
                {labelled ? t('trigger') : null}
            </Button>
            <ReportDialog
                open={open}
                setOpen={setOpen}
                subjectKind={subjectKind}
                subjectId={subjectId}
            />
        </>
    );
}

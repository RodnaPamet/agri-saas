'use client';

/**
 * «Нови съобщения» — the read boundary in a conversation (P8.3, #2797).
 *
 * ## It marks the CURSOR, not the unread count
 *
 * The line sits above the first message the reader has not seen, which is a
 * position rather than a number. A count would duplicate the inbox badge and
 * would have to be kept in step with it; a position is derivable from one
 * value the server already sends — `lastReadAt` on the conversation read.
 *
 * ## It does NOT move while the reader is looking at it
 *
 * The divider is placed from the cursor as it was when the conversation
 * OPENED, and the caller is expected to hold that value still. Recomputing it
 * as new messages arrive would walk the line down the screen under the
 * reader's eyes and lose the one thing it is for: showing where they stopped.
 * That is the caller's job because only the caller knows when a conversation
 * was opened; this component renders a boundary it is given.
 */
import { useTranslations } from 'next-intl';

export function NewMessagesDivider() {
    const t = useTranslations('chat');
    return (
        <div className="flex items-center gap-tight py-tight" role="separator">
            <span className="h-px flex-1 bg-border-emphasis" />
            {/*
              * `border-border-emphasis` on the rules rather than `subtle`:
              * this one IS state — "you stopped here" — and the border-tone
              * rule reserves emphasis for exactly that.
              */}
            <span className="text-xs font-[560] text-content-muted">{t('newMessages')}</span>
            <span className="h-px flex-1 bg-border-emphasis" />
        </div>
    );
}

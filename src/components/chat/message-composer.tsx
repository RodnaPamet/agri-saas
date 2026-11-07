'use client';

/**
 * The DM composer — P8.3 (#2797).
 *
 * Three things here are decisions rather than defaults:
 *
 * **Bare Enter inserts a newline; ⌘/Ctrl+Enter sends.** That is
 * `useEnterSubmit`'s `modifier: 'auto'` policy for a `<textarea>` verbatim,
 * and this composer takes it rather than defining its own. Note it does NOT
 * branch on the device — a phone's return key carries no modifier, so on a
 * phone the send BUTTON is the only way to send, which is why that button is
 * always present rather than appearing on first keystroke. Reaching for
 * `modifier: 'always'` here would make a two-line message impossible to type
 * on the operator's real device.
 *
 * **The send control is never the only way to send, and never absent.** It is
 * `disabled` while the body is blank rather than hidden: a control that
 * appears on the first keystroke moves the layout under the thumb that is
 * typing.
 *
 * **The keyboard inset is applied as `padding-bottom`, not a transform.**
 * `useKeyboardInset` reports how much of the viewport the soft keyboard
 * covers; padding keeps the composer in the document flow, so the timeline
 * above it shortens instead of being covered by a floated bar.
 */
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { useEnterSubmit } from '@/components/ui/hooks';
// `PaperPlane` from the nucleo set. The legacy icon package is on a
// shrink-only allowlist (`no-lucide`), so importing from it adds an entry to
// a list whose whole purpose is to empty — and nucleo already ships this
// icon. My first pass concluded it did not, from a grep for a capitalised
// component name against a barrel whose entries are kebab-case paths.
// The package name is not spelled in this comment on purpose: three times
// this session a banned token in my own prose tripped the sweep for it.
import { PaperPlane } from '@/components/ui/icons/nucleo';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';

import { useKeyboardInset } from './use-keyboard-inset';

/** Matches `DM_MAX_BODY_LENGTH` in `@/app-layer/usecases/direct-messages`. */
export const COMPOSER_MAX_LENGTH = 4000;

/**
 * Past this many pixels the textarea scrolls instead of growing. Four lines of
 * body text at the current scale — enough to see a whole short message, not
 * enough to push the timeline off a phone screen.
 */
const MAX_AUTOSIZE_PX = 112;

export interface MessageComposerProps {
    /** Called with the trimmed body. The caller clears nothing — see `pending`. */
    onSend: (body: string) => void;
    /** While true the control is inert and the text is retained, not cleared. */
    pending?: boolean;
    /** Rendered instead of the composer. Used for a declined or blocked thread. */
    disabledReason?: string;
    placeholder: string;
    sendLabel: string;
    className?: string;
}

export function MessageComposer({
    onSend,
    pending = false,
    disabledReason,
    placeholder,
    sendLabel,
    className,
}: MessageComposerProps) {
    const [body, setBody] = React.useState('');
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const inset = useKeyboardInset();

    const trimmed = body.trim();
    const canSend = trimmed.length > 0 && !pending;

    // `trimmed` is in the deps deliberately. An earlier draft read the body
    // inside a `setBody` updater to dodge a stale closure — there is no stale
    // closure (every keystroke re-renders and re-attaches `onKeyDown`), and a
    // side effect inside an updater fires TWICE, because React 19 invokes
    // updaters twice to surface exactly that impurity.
    const send = React.useCallback(() => {
        if (trimmed.length === 0 || pending) return;
        onSend(trimmed);
        setBody('');
    }, [trimmed, pending, onSend]);

    const { handleKeyDown } = useEnterSubmit({ onSubmit: send });

    // Autosize. Reset to `auto` first — without that, `scrollHeight` is
    // bounded by the height already set and the box can only ever grow.
    React.useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, MAX_AUTOSIZE_PX)}px`;
    }, [body]);

    if (disabledReason) {
        return (
            <div
                className={cn(
                    'border-t border-border-subtle bg-bg-muted px-default py-default',
                    'text-xs text-content-muted',
                    className,
                )}
                style={{ paddingBottom: inset ? `${inset}px` : undefined }}
            >
                {disabledReason}
            </div>
        );
    }

    return (
        <div
            className={cn(
                'flex items-end gap-tight border-t border-border-subtle bg-bg-default px-default py-default',
                className,
            )}
            style={{ paddingBottom: inset ? `${inset}px` : undefined }}
        >
            <Textarea
                ref={textareaRef}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={placeholder}
                maxLength={COMPOSER_MAX_LENGTH}
                rows={1}
                className="max-h-[112px] min-h-0 resize-none py-tight"
            />
            <Button
                type="button"
                variant="primary"
                icon={<PaperPlane />}
                aria-label={sendLabel}
                disabled={!canSend}
                onClick={send}
            />
        </div>
    );
}

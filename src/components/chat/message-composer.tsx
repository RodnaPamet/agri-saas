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
 *
 * ## The quoted message, and what clears it (#2829)
 *
 * `quoted` is HELD BY THE CALLER, like `pending` and for the same reason: the
 * composer clears nothing it was given. The page owns the quoted state because
 * the quote has to survive a re-render of the timeline, and a component that
 * paged away would lose it.
 *
 * It renders ABOVE the textarea and inside the same bordered bar, so it moves
 * with the composer when the keyboard opens rather than being covered by it.
 *
 * **It persists until cleared or sent, and a tap elsewhere does NOT clear it.**
 * That was a genuinely open product choice and this is the conservative side:
 * a quote lost to a stray tap sends a message without its context, and the
 * reader cannot tell that the sender meant to answer something. The explicit
 * dismiss control is the way out, and it is a real button rather than a
 * gesture for the reason every control in this component is.
 */
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { useEnterSubmit } from '@/components/ui/hooks';
import { IconAction } from '@/components/ui/icon-action';
// `PaperPlane` from the nucleo set. The legacy icon package is on a
// shrink-only allowlist (`no-lucide`), so importing from it adds an entry to
// a list whose whole purpose is to empty — and nucleo already ships this
// icon. My first pass concluded it did not, from a grep for a capitalised
// component name against a barrel whose entries are kebab-case paths.
// The package name is not spelled in this comment on purpose: three times
// this session a banned token in my own prose tripped the sweep for it.
import { PaperPlane, Xmark } from '@/components/ui/icons/nucleo';
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
    /**
     * The message being answered, or null. Held by the CALLER — this component
     * clears nothing it was given, exactly as it does not clear `body` on
     * `pending`.
     *
     * `deleted` is a field rather than inferred from a null `body`, because a
     * photo-only message has a null body too (P8.6).
     */
    quoted?: {
        senderLabel?: string | null;
        body: string | null;
        deleted: boolean;
    } | null;
    /** Drop the quote. Required whenever `quoted` is passed, or it is a trap. */
    onClearQuote?: () => void;
    /** Accessible name for the dismiss control. */
    clearQuoteLabel?: string;
    /** Rendered above the quote's body, naming what the quote is. */
    replyingToLabel?: string;
}

export function MessageComposer({
    onSend,
    pending = false,
    disabledReason,
    placeholder,
    sendLabel,
    className,
    quoted,
    onClearQuote,
    clearQuoteLabel,
    replyingToLabel,
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
                // A COLUMN now, because the quote sits above the row rather
                // than beside it — a quote in the same flex row as the
                // textarea would shrink the typing area as the quote grew.
                'flex flex-col gap-tight border-t border-border-subtle bg-bg-default px-default py-default',
                className,
            )}
            style={{ paddingBottom: inset ? `${inset}px` : undefined }}
        >
            {quoted ? (
                <div className="flex items-start gap-tight">
                    <div
                        className={cn(
                            // `border-l`, matching the quote inside a bubble:
                            // the same thing rendered in two places should
                            // read as the same thing.
                            'min-w-0 flex-1 truncate border-l-2 border-border-subtle px-2 py-0.5',
                            'text-xs text-content-muted',
                        )}
                    >
                        {replyingToLabel ? (
                            <span className="font-[560]">{replyingToLabel} </span>
                        ) : null}
                        {quoted.senderLabel ? (
                            <span className="font-[560]">{quoted.senderLabel}: </span>
                        ) : null}
                        {quoted.deleted ? (
                            <span className="italic">{quoted.body}</span>
                        ) : (
                            quoted.body
                        )}
                    </div>
                    {onClearQuote ? (
                        // A real BUTTON, not a swipe or a tap-outside. The
                        // quote persists deliberately (see the docblock), so
                        // the only way out has to be keyboard-reachable and
                        // always present — `IconAction` carries the #765
                        // coarse-pointer 44px floor with it.
                        <IconAction
                            icon={<Xmark />}
                            label={clearQuoteLabel ?? ''}
                            variant="ghost"
                            onClick={onClearQuote}
                        />
                    ) : null}
                </div>
            ) : null}
            <div className="flex items-end gap-tight">
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
        </div>
    );
}

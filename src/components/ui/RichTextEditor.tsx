'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * `<RichTextEditor>` — reusable authoring primitive built on Tiptap.
 *
 * Two-mode editor:
 *
 *   - **MARKDOWN** — plain `<textarea>` editing. The current policy
 *     content path stores markdown as literal text (no markdown
 *     parser at render time); we preserve that contract bit-for-bit
 *     so existing rendering keeps working.
 *
 *   - **HTML** (WYSIWYG) — Tiptap `EditorContent` with the
 *     starter-kit extensions, link, placeholder. Output is HTML
 *     and the consumer is expected to run it through
 *     `sanitizePolicyContent('HTML', ...)` (or equivalent
 *     `sanitizeRichTextHtml`) before persistence; the backend
 *     already does this defensively at the policy usecase layer.
 *
 * Mode toggle is internal — the consumer passes a `contentType` and
 * receives `(value, contentType)` updates from `onChange`. Switching
 * modes preserves the underlying text payload (markdown text drops
 * into Tiptap as plain paragraphs; HTML coming back goes into the
 * textarea verbatim — round-trip-safe for the storage layer because
 * the contentType prop changes at the same time).
 *
 * Bundle posture: callers SHOULD lazy-load this component via
 * `next/dynamic({ ssr: false })` so the Tiptap + ProseMirror chunks
 * (~200KB gzipped) don't land in every policy detail page render —
 * only when the user opens the editor tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Card } from '@/components/ui/card';
import {
    Bold,
    Italic,
    Strikethrough,
    Heading1,
    Heading2,
    List,
    ListOrdered,
    Quote,
    Code as CodeIcon,
    Link as LinkIcon,
    Eye,
    Pencil,
} from 'lucide-react';

export type RichTextContentType = 'MARKDOWN' | 'HTML';

export interface RichTextEditorProps {
    /** Current text payload — interpretation depends on `contentType`. */
    value: string;
    /** Markdown text vs HTML markup. Drives the rendered editor mode. */
    contentType: RichTextContentType;
    /**
     * Called on every edit AND on mode toggle. The second argument
     * tells the consumer which content type the value is in — so a
     * user toggling from markdown → wysiwyg sends `(htmlValue,
     * 'HTML')` even before any character is typed.
     */
    onChange: (value: string, contentType: RichTextContentType) => void;
    /** Placeholder shown in the empty editor body. */
    placeholder?: string;
    /** Disable editing entirely (still renders the current value). */
    disabled?: boolean;
    /** Min editor height. Default `300px`. */
    minHeightPx?: number;
    /** Optional id to forward (E2E selectors). */
    id?: string;
    /** Test id for the outer wrapper. */
    'data-testid'?: string;
    className?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Tiptap's StarterKit ships with sensible defaults; we tighten the
 * Link extension so it cannot mint un-prefixed JS / data: URLs (the
 * server-side sanitiser would scrub these anyway, this keeps the
 * editor honest at edit-time).
 */
function buildExtensions(placeholder: string) {
    return [
        StarterKit.configure({
            heading: { levels: [1, 2, 3] },
            // CodeBlock is overkill for policy authoring; use inline
            // code from StarterKit (Code mark) instead.
            codeBlock: false,
            // Disable the bundled Link mark — we register a tightened
            // standalone `Link.configure(...)` below with stricter
            // protocol validation. Without this, both register under
            // the same name and TipTap warns about duplicate
            // extensions, which can cause non-deterministic behavior
            // for paste handling and link auto-detection.
            link: false,
        }),
        Link.configure({
            openOnClick: false,
            autolink: true,
            HTMLAttributes: {
                rel: 'noopener noreferrer nofollow',
                target: '_blank',
            },
            // Reject dangerous protocols at edit-time.
            validate: (href) => /^(https?:|mailto:|\/)/.test(href),
        }),
        Placeholder.configure({ placeholder }),
    ];
}

// ─── Component ──────────────────────────────────────────────────────

export function RichTextEditor({
    value,
    contentType,
    onChange,
    placeholder: placeholderProp,
    disabled = false,
    minHeightPx = 300,
    id,
    'data-testid': dataTestId = 'rich-text-editor',
    className = '',
}: RichTextEditorProps) {
    const t = useTranslations('ui');
    const placeholder = placeholderProp ?? t('richTextEditor.defaultPlaceholder');
    const [mode, setMode] = useState<RichTextContentType>(contentType);
    // Track whether onChange originated from the editor (avoids the
    // round-trip render → onUpdate → setEditorContent loop).
    const fromEditorRef = useRef(false);

    // ── Tiptap instance ────────────────────────────────────────────
    const editor = useEditor({
        extensions: buildExtensions(placeholder),
        content: contentType === 'HTML' ? value : '',
        editable: !disabled && mode === 'HTML',
        immediatelyRender: false,
        editorProps: {
            attributes: {
                class:
                    'prose prose-sm prose-invert max-w-none p-4 focus:outline-none',
                'data-testid': 'rich-text-editor-content',
                role: 'textbox',
                'aria-multiline': 'true',
                'aria-label': t('richTextEditor.editorAriaLabel'),
            },
        },
        onUpdate: ({ editor: ed }) => {
            fromEditorRef.current = true;
            onChange(ed.getHTML(), 'HTML');
            // micro-task gate: clear after the same tick so the
            // useEffect below doesn't reset content.
            queueMicrotask(() => {
                fromEditorRef.current = false;
            });
        },
    });

    // Re-sync external `value` changes when in HTML mode (e.g. parent
    // resets the value after a successful save).
    useEffect(() => {
        if (!editor) return;
        if (fromEditorRef.current) return;
        if (mode !== 'HTML') return;
        const current = editor.getHTML();
        if (current !== value) {
            editor.commands.setContent(value || '', { emitUpdate: false });
        }
    }, [editor, value, mode]);

    // External `contentType` change — drive the mode (rare but
    // supported, e.g. parent flips mode programmatically).
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMode(contentType);
    }, [contentType]);

    // Toggle between modes. The text payload bridges via:
    //   markdown → HTML: wrap markdown in a single <pre>-ish text
    //     block so newlines preserve. (No markdown parser today —
    //     keeps the bundle lean; user can re-author in WYSIWYG.)
    //   HTML → markdown: extract plain text via editor.getText()
    //     (loses formatting; explicit, expected, and recoverable
    //     because saving doesn't lose the text).
    const toggleMode = useCallback(() => {
        if (!editor) return;
        const next: RichTextContentType = mode === 'MARKDOWN' ? 'HTML' : 'MARKDOWN';
        if (next === 'HTML') {
            // Markdown text → set as a single paragraph block so the
            // editor mounts something sensible.
            const seeded = value
                ? value
                      .split(/\n{2,}/)
                      .map((p) => `<p>${escapeHtml(p)}</p>`)
                      .join('')
                : '';
            editor.commands.setContent(seeded, { emitUpdate: false });
            editor.setEditable(true);
            setMode('HTML');
            onChange(seeded, 'HTML');
        } else {
            const plain = editor.getText();
            editor.setEditable(false);
            setMode('MARKDOWN');
            onChange(plain, 'MARKDOWN');
        }
    }, [editor, mode, value, onChange]);

    // ── Render ─────────────────────────────────────────────────────
    return (
        <Card
            elevation="inset"
            density="none"
            id={id}
            data-testid={dataTestId}
            data-content-type={mode}
            className={className}
        >
            <Toolbar
                mode={mode}
                editor={editor}
                disabled={disabled}
                onToggleMode={toggleMode}
            />
            {mode === 'MARKDOWN' ? (
                <textarea
                    className="input w-full rounded-none border-0 border-t border-border-default bg-transparent font-mono text-base md:text-sm focus:ring-0"
                    style={{ minHeight: `${minHeightPx}px` }}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => {
                        fromEditorRef.current = true;
                        onChange(e.target.value, 'MARKDOWN');
                        queueMicrotask(() => {
                            fromEditorRef.current = false;
                        });
                    }}
                    placeholder={placeholder}
                    data-testid="rich-text-editor-textarea"
                />
            ) : (
                <div
                    className="border-t border-border-default"
                    style={{ minHeight: `${minHeightPx}px` }}
                >
                    <EditorContent editor={editor} />
                </div>
            )}
        </Card>
    );
}

// ─── Toolbar ────────────────────────────────────────────────────────

function Toolbar({
    mode,
    editor,
    disabled,
    onToggleMode,
}: {
    mode: RichTextContentType;
    editor: Editor | null;
    disabled: boolean;
    onToggleMode: () => void;
}) {
    const t = useTranslations('ui');
    return (
        <div className="flex flex-wrap items-center gap-1 border-b border-border-default px-2 py-1.5">
            <button
                type="button"
                onClick={onToggleMode}
                disabled={disabled}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-content-muted hover:bg-bg-muted hover:text-content-emphasis disabled:opacity-50"
                aria-label={mode === 'MARKDOWN' ? t('richTextEditor.switchToWysiwyg') : t('richTextEditor.switchToMarkdown')}
                data-testid="rich-text-editor-toggle"
                data-mode={mode}
            >
                {mode === 'MARKDOWN' ? (
                    <>
                        <Eye size={11} /> {t('richTextEditor.wysiwyg')}
                    </>
                ) : (
                    <>
                        <Pencil size={11} /> {t('richTextEditor.markdown')}
                    </>
                )}
            </button>
            {mode === 'HTML' && editor && (
                <>
                    <Divider />
                    <FormatButton
                        editor={editor}
                        action={() => editor.chain().focus().toggleBold().run()}
                        active={editor.isActive('bold')}
                        icon={<Bold size={12} />}
                        label={t('richTextEditor.bold')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() => editor.chain().focus().toggleItalic().run()}
                        active={editor.isActive('italic')}
                        icon={<Italic size={12} />}
                        label={t('richTextEditor.italic')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() => editor.chain().focus().toggleStrike().run()}
                        active={editor.isActive('strike')}
                        icon={<Strikethrough size={12} />}
                        label={t('richTextEditor.strikethrough')}
                    />
                    <Divider />
                    <FormatButton
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleHeading({ level: 1 }).run()
                        }
                        active={editor.isActive('heading', { level: 1 })}
                        icon={<Heading1 size={12} />}
                        label={t('richTextEditor.heading1')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleHeading({ level: 2 }).run()
                        }
                        active={editor.isActive('heading', { level: 2 })}
                        icon={<Heading2 size={12} />}
                        label={t('richTextEditor.heading2')}
                    />
                    <Divider />
                    <FormatButton
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleBulletList().run()
                        }
                        active={editor.isActive('bulletList')}
                        icon={<List size={12} />}
                        label={t('richTextEditor.bulletList')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleOrderedList().run()
                        }
                        active={editor.isActive('orderedList')}
                        icon={<ListOrdered size={12} />}
                        label={t('richTextEditor.numberedList')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() =>
                            editor.chain().focus().toggleBlockquote().run()
                        }
                        active={editor.isActive('blockquote')}
                        icon={<Quote size={12} />}
                        label={t('richTextEditor.quote')}
                    />
                    <FormatButton
                        editor={editor}
                        action={() => editor.chain().focus().toggleCode().run()}
                        active={editor.isActive('code')}
                        icon={<CodeIcon size={12} />}
                        label={t('richTextEditor.inlineCode')}
                    />
                    <Divider />
                    <button
                        type="button"
                        onClick={() => {
                            const url = window.prompt(
                                t('richTextEditor.linkPrompt'),
                            );
                            if (!url) return;
                            editor
                                .chain()
                                .focus()
                                .extendMarkRange('link')
                                .setLink({ href: url })
                                .run();
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-content-muted hover:bg-bg-muted hover:text-content-emphasis"
                        aria-label={t('richTextEditor.insertLink')}
                        data-testid="rich-text-editor-link"
                    >
                        <LinkIcon size={12} />
                    </button>
                </>
            )}
        </div>
    );
}

function Divider() {
    return <span aria-hidden className="mx-0.5 h-3 w-px bg-border-default" />;
}

function FormatButton({
    action,
    active,
    icon,
    label,
}: {
    editor: Editor;
    action: () => void;
    active: boolean;
    icon: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={action}
            className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                active
                    ? 'bg-bg-muted text-content-emphasis'
                    : 'text-content-muted hover:bg-bg-muted hover:text-content-emphasis'
            }`}
            aria-label={label}
            aria-pressed={active}
            title={label}
            data-active={active ? 'true' : 'false'}
        >
            {icon}
        </button>
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Cheap HTML-escape used only to seed the editor when migrating
 * markdown text into WYSIWYG mode. The eventual save path runs the
 * full `sanitizeRichTextHtml` allowlist; this is just to avoid
 * mounting raw user text as HTML inside Tiptap.
 */
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

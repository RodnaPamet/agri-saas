'use client';

/**
 * Copy-once display for a freshly-minted API key.
 *
 * Extracted from `page.tsx` because a Next PAGE module may only export a
 * default component plus a fixed set of config keys — exporting this named
 * component made `.next/types` reject the module. That failure is invisible
 * in CI: the Typecheck job runs without a build, so the generated constraint
 * files never exist, and the only place it surfaced was a local `tsc` that
 * happened to follow a build. See
 * `tests/guards/app-router-module-exports.test.ts`, which makes the whole
 * class visible without needing a build.
 *
 * It gets its own file rather than being inlined and untested, because the
 * security property it carries — the plaintext key is MASKED until the
 * operator asks for it — is worth testing directly. Two rendered suites
 * import it: `tests/rendered/api-keys-page.test.tsx` and
 * `tests/rendered/api-key-display.test.tsx`.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Tooltip } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/components/ui/hooks';
import { useToast } from '@/components/ui/hooks/use-toast';

export function KeyDisplay({ plaintext }: { plaintext: string }) {
    const t = useTranslations('admin.apiKeys');
    const [visible, setVisible] = useState(false);
    const { copy, copied } = useCopyToClipboard({ timeout: 2500 });
    const toast = useToast();

    const handleCopy = async () => {
        const ok = await copy(plaintext);
        if (ok) {
            toast.success(t('keyCopied'));
        } else {
            toast.error(t('keyCopyFailed'));
        }
    };

    return (
        <InlineNotice
            variant="warning"
            id="key-display"
            icon={AlertTriangle}
            title={t('copyKeyNow')}
            className="flex-col items-stretch space-y-tight p-4"
        >
            <div className="flex items-center gap-tight">
                <code className="flex-1 bg-bg-page px-3 py-2 rounded text-sm font-mono text-content-success select-all break-all">
                    {visible ? plaintext : plaintext.slice(0, 13) + '•'.repeat(40)}
                </code>
                <Tooltip content={visible ? t('hideKey') : t('showKey')}>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setVisible(!visible)}
                        aria-label={visible ? t('hideKey') : t('showKey')}
                        id="key-toggle-visibility"
                    >
                        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </Button>
                </Tooltip>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopy}
                    id="key-copy-btn"
                >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? t('copiedExclaim') : t('copy')}
                </Button>
            </div>
        </InlineNotice>
    );
}

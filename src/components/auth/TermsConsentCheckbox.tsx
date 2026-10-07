'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Checkbox } from '@/components/ui/checkbox';

export interface TermsConsentCheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Distinct per mount — two consent controls must not share an id. */
    id?: string;
    disabled?: boolean;
}

/**
 * The one consent control (P3.1).
 *
 * There are two places a person is asked to accept the terms, and they must ask
 * the same thing in the same words:
 *
 *   * the registration wizard's step 1, for an email signup;
 *   * `/accept-terms`, for a session that arrived through Google OAuth and so
 *     was never asked (#1376).
 *
 * This existed twice before, with byte-identical copy under two keys
 * (`farmWizard.consentLabel` and `acceptTerms.label`). That is the shape where
 * one of them gets edited — a changed link, a reworded sentence — and the other
 * quietly keeps saying something else, which for a consent record is a
 * difference that matters: the two users would have agreed to differently
 * worded things while the stored version string claims they agreed to the same
 * document.
 *
 * So the copy lives under ONE key, `common.termsConsentLabel`, and this is its
 * only renderer. The `tests/guards/formfield-coverage.test.ts` budget is what
 * surfaced the duplication: adding a third raw `<label>` pushed it over, and
 * the fix that satisfied it was the one that should have happened anyway.
 *
 * ── why a raw label rather than FormField ──
 *
 * `<FormField>` wraps an input with label / description / required / error
 * slots, around a control whose label is a short string. This is a checkbox
 * whose label is a SENTENCE containing two links — the links are the point,
 * since you cannot meaningfully accept a document you cannot open. Threading
 * rich content through FormField's label slot would fight it rather than use
 * it.
 *
 * The links open in a new tab deliberately: the commonest reason somebody
 * abandons a signup at this step is leaving to read the terms and not coming
 * back, and losing a half-filled form to that is avoidable.
 */
export function TermsConsentCheckbox({
    checked,
    onChange,
    id = 'terms-consent',
    disabled,
}: TermsConsentCheckboxProps) {
    const t = useTranslations('common');

    return (
        <div className="flex items-start gap-tight">
            <Checkbox
                id={id}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(v) => onChange(v === true)}
            />
            <label htmlFor={id} className="text-sm text-content-muted">
                {t.rich('termsConsentLabel', {
                    terms: (chunks) => (
                        <Link
                            href="/terms"
                            target="_blank"
                            rel="noopener"
                            className="underline hover:text-content-emphasis"
                        >
                            {chunks}
                        </Link>
                    ),
                    privacy: (chunks) => (
                        <Link
                            href="/privacy"
                            target="_blank"
                            rel="noopener"
                            className="underline hover:text-content-emphasis"
                        >
                            {chunks}
                        </Link>
                    ),
                })}
            </label>
        </div>
    );
}

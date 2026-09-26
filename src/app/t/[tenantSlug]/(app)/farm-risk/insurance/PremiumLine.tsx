'use client';

/**
 * The live premium, under the cover fields.
 *
 * It recalculates on every keystroke — there is no Calculate button, because a
 * farmer comparing cover levels should not have to ask for each answer.
 *
 * The visible text and the announced text are deliberately DIFFERENT nodes.
 * An `aria-live` region that changes on every keystroke makes a screen reader
 * talk over itself, so the announcement is debounced while the visible figure
 * stays immediate.
 */
import { useTranslations } from 'next-intl';
import { useDebounce } from '@/components/ui/hooks';

export function PremiumLine({ text }: { text: string | null }) {
    const t = useTranslations('ag.risk.quote');
    const announced = useDebounce(text, 500);

    return (
        <div className="mt-2">
            <p
                id="insurance-quote-premium"
                className="text-sm font-medium text-content-emphasis"
                // Announced by the live region below instead, debounced.
                aria-hidden="true"
            >
                {text ?? ' '}
            </p>
            <span className="sr-only" role="status" aria-live="polite">
                {announced ?? ''}
            </span>
            <span className="sr-only">{t('premiumLabel')}</span>
        </div>
    );
}

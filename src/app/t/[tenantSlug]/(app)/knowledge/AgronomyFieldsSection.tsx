'use client';

/**
 * Crop tags / regions / BBCH growth-stage range — the agronomy metadata
 * shared by NewArticleModal and EditArticleModal (S3, KB agronomy
 * structure PR).
 *
 * Crop tags and regions are entered as a comma-separated list (parsed +
 * sanitised server-side by `sanitizeTagArray` in `usecases/knowledge.ts`);
 * an empty list means "applies to every crop / region" (see the schema
 * header in `prisma/schema/knowledge.prisma`). BBCH uses a `Switch` +
 * two `NumberStepper` practices (Epic 60 — never a raw
 * `<input type="number">`) rather than a free-text pair, since it is a
 * bounded 0-99 ordinal scale and a stray value would otherwise round-trip
 * through a 400 the user can't see coming.
 */

import { useTranslations } from 'next-intl';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';

export interface AgronomyFieldsValue {
    cropTags: string;
    regions: string;
    bbchEnabled: boolean;
    bbchMin: number;
    bbchMax: number;
}

export interface AgronomyFieldsSectionProps extends AgronomyFieldsValue {
    onCropTagsChange: (value: string) => void;
    onRegionsChange: (value: string) => void;
    onBbchEnabledChange: (value: boolean) => void;
    onBbchMinChange: (value: number) => void;
    onBbchMaxChange: (value: number) => void;
    disabled?: boolean;
    /** Prefix for stable element ids, e.g. "new-article" / "edit-article". */
    idPrefix: string;
}

export function AgronomyFieldsSection({
    cropTags,
    onCropTagsChange,
    regions,
    onRegionsChange,
    bbchEnabled,
    onBbchEnabledChange,
    bbchMin,
    onBbchMinChange,
    bbchMax,
    onBbchMaxChange,
    disabled,
    idPrefix,
}: AgronomyFieldsSectionProps) {
    const t = useTranslations('knowledge.agronomyFields');

    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                <FormField label={t('fieldCropTags')} hint={t('cropTagsHint')}>
                    <Input
                        id={`${idPrefix}-crop-tags-input`}
                        value={cropTags}
                        onChange={(e) => onCropTagsChange(e.target.value)}
                        placeholder={t('cropTagsPlaceholder')}
                        disabled={disabled}
                    />
                </FormField>
                <FormField label={t('fieldRegions')} hint={t('regionsHint')}>
                    <Input
                        id={`${idPrefix}-regions-input`}
                        value={regions}
                        onChange={(e) => onRegionsChange(e.target.value)}
                        placeholder={t('regionsPlaceholder')}
                        disabled={disabled}
                    />
                </FormField>
            </div>
            <FormField label={t('fieldBbchRange')} hint={t('bbchHint')}>
                <div className="flex items-center gap-default">
                    <Switch
                        id={`${idPrefix}-bbch-toggle`}
                        checked={bbchEnabled}
                        onCheckedChange={onBbchEnabledChange}
                        disabled={disabled}
                        aria-label={t('fieldBbchRange')}
                    />
                    {bbchEnabled && (
                        <div className="flex flex-1 items-center gap-compact">
                            <NumberStepper
                                id={`${idPrefix}-bbch-min-input`}
                                value={bbchMin}
                                onChange={onBbchMinChange}
                                min={0}
                                max={99}
                                size="sm"
                                ariaLabel={t('bbchMinAria')}
                                disabled={disabled}
                            />
                            <span className="text-xs text-content-subtle">{t('bbchRangeSeparator')}</span>
                            <NumberStepper
                                id={`${idPrefix}-bbch-max-input`}
                                value={bbchMax}
                                onChange={onBbchMaxChange}
                                min={0}
                                max={99}
                                size="sm"
                                ariaLabel={t('bbchMaxAria')}
                                disabled={disabled}
                            />
                        </div>
                    )}
                </div>
            </FormField>
        </>
    );
}

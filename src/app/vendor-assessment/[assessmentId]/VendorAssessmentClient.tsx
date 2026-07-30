'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic G-3 — vendor-facing response form (public, token-gated).
 *
 * Three states:
 *
 *   • LOADING   — fetching the assessment + template
 *   • READY     — form rendered, vendor fills in answers
 *   • SUBMITTED — confirmation screen
 *
 * Plus terminal error states for `expired` / `wrong_status` (link no
 * longer active) and any other fetch failure.
 *
 * The component is intentionally minimal — no app-shell chrome, no
 * tenant-context dependency, no internal admin concepts. Vendors
 * see only what they need.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/typography';
import { RequiredMarker } from '@/components/ui/required-marker';

interface Question {
    id: string;
    sortOrder: number;
    prompt: string;
    answerType:
        | 'YES_NO'
        | 'SINGLE_SELECT'
        | 'MULTI_SELECT'
        | 'TEXT'
        | 'NUMBER'
        | 'SCALE'
        | 'FILE_UPLOAD';
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}
interface Section {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: Question[];
}
interface LoadResponse {
    assessmentId: string;
    status: string;
    expiresAtIso: string | null;
    vendor: { name: string };
    template: {
        name: string;
        description: string | null;
        sections: Section[];
    };
    answers: Array<{ questionId: string; answerJson: unknown }>;
}

type Phase = 'loading' | 'ready' | 'submitted' | 'error';

export function VendorAssessmentClient({
    assessmentId,
    initialToken,
}: {
    assessmentId: string;
    initialToken: string;
}) {
    const t = useTranslations('vendorAssessment');
    const [phase, setPhase] = useState<Phase>('loading');
    const [errorReason, setErrorReason] = useState<string | null>(null);
    const [data, setData] = useState<LoadResponse | null>(null);
    const [answers, setAnswers] = useState<Record<string, unknown>>({});
    const [submitting, setSubmitting] = useState(false);
    const [submitErrors, setSubmitErrors] = useState<
        Array<{ questionId: string | null; message: string }>
    >([]);

    useEffect(() => {
        if (!initialToken) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPhase('error');
            setErrorReason('missing_token');
            return;
        }
        (async () => {
            try {
                const res = await fetch(
                    `/api/vendor-assessment/${assessmentId}?t=${encodeURIComponent(initialToken)}`,
                );
                if (!res.ok) {
                    const body = (await res
                        .json()
                        .catch(() => ({}))) as { reason?: string };
                    setPhase('error');
                    setErrorReason(body.reason ?? 'unknown');
                    return;
                }
                const payload = (await res.json()) as LoadResponse;
                setData(payload);
                // Pre-populate from existing answers if any.
                const initial: Record<string, unknown> = {};
                for (const a of payload.answers) initial[a.questionId] = a.answerJson;
                setAnswers(initial);
                setPhase('ready');
            } catch {
                setPhase('error');
                setErrorReason('network');
            }
        })();
    }, [assessmentId, initialToken]);

    if (phase === 'loading') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <p className="text-sm text-gray-500">{t('loading')}</p>
            </div>
        );
    }

    if (phase === 'error') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
                <div
                    className="max-w-md text-center bg-white p-8 rounded-lg shadow"
                    data-testid="vendor-assessment-error"
                >
                    <h1 className="text-xl font-semibold text-gray-900 mb-2">
                        {t('errorTitle')}
                    </h1>
                    <p className="text-sm text-gray-600">
                        {errorReason === 'expired'
                            ? t('errorExpired')
                            : errorReason === 'wrong_status'
                                ? t('errorWrongStatus')
                                : t('errorGeneric')}
                    </p>
                </div>
            </div>
        );
    }

    if (phase === 'submitted') {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
                <div
                    className="max-w-md text-center bg-white p-8 rounded-lg shadow"
                    data-testid="vendor-assessment-submitted"
                >
                    <h1 className="text-xl font-semibold text-gray-900 mb-2">
                        {t('submittedTitle')}
                    </h1>
                    <p className="text-sm text-gray-600">
                        {t('submittedBody')}
                    </p>
                </div>
            </div>
        );
    }

    if (!data) return null;

    async function handleSubmit() {
        setSubmitting(true);
        setSubmitErrors([]);
        try {
            const payload = Object.entries(answers).map(([questionId, value]) => ({
                questionId,
                answerJson: { value },
                evidenceId: null,
            }));
            const res = await fetch(
                `/api/vendor-assessment/${assessmentId}/submit`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: initialToken, answers: payload }),
                },
            );
            if (!res.ok) {
                const body = (await res.json().catch(() => ({}))) as {
                    error?: string;
                    fieldErrors?: Array<{
                        questionId: string | null;
                        message: string;
                    }>;
                    reason?: string;
                };
                if (body.error === 'validation_failed' && body.fieldErrors) {
                    setSubmitErrors(body.fieldErrors);
                    return;
                }
                if (body.error === 'access_denied') {
                    setPhase('error');
                    setErrorReason(body.reason ?? 'unknown');
                    return;
                }
                setSubmitErrors([
                    {
                        questionId: null,
                        message: t('submitFailed'),
                    },
                ]);
                return;
            }
            setPhase('submitted');
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="min-h-screen bg-gray-50 py-10 px-4">
            <div
                className="max-w-2xl mx-auto bg-white rounded-lg shadow p-8"
                data-testid="vendor-assessment-form"
            >
                <header className="border-b pb-4 mb-6">
                    <p className="text-xs uppercase tracking-wide text-gray-500">
                        {t('headerLabel', { name: data.vendor.name })}
                    </p>
                    <Heading level={1} className="text-gray-900 mt-1">
                        {data.template.name}
                    </Heading>
                    {data.template.description && (
                        <p className="text-sm text-gray-600 mt-2">
                            {data.template.description}
                        </p>
                    )}
                </header>

                {submitErrors.length > 0 && (
                    <div
                        className="border border-border-error bg-bg-error text-content-error text-sm p-4 rounded mb-4"
                        role="alert"
                        data-testid="vendor-assessment-submit-errors"
                    >
                        <strong>{t('fixFollowing')}</strong>
                        <ul className="mt-2 list-disc list-inside">
                            {submitErrors.map((e, i) => (
                                <li key={`${e.questionId ?? 'global'}:${i}`}>
                                    {e.message}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        handleSubmit();
                    }}
                    className="space-y-page"
                >
                    {data.template.sections.map((section) => (
                        <section key={section.id}>
                            <Heading level={2} className="text-gray-900 mb-1">
                                {section.title}
                            </Heading>
                            {section.description && (
                                <p className="text-sm text-gray-600 mb-4">
                                    {section.description}
                                </p>
                            )}
                            <div className="space-y-default">
                                {section.questions.map((q) => (
                                    <QuestionField
                                        key={q.id}
                                        question={q}
                                        value={answers[q.id]}
                                        onChange={(v) =>
                                            setAnswers((prev) => ({
                                                ...prev,
                                                [q.id]: v,
                                            }))
                                        }
                                    />
                                ))}
                            </div>
                        </section>
                    ))}

                    <div className="flex justify-end pt-4 border-t">
                        <button
                            type="submit"
                            disabled={submitting}
                            data-testid="vendor-assessment-submit-btn"
                            className="bg-indigo-600 text-white px-6 py-2 rounded-md font-medium disabled:opacity-50"
                        >
                            {submitting ? t('submitting') : t('submitResponses')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function QuestionField({
    question,
    value,
    onChange,
}: {
    question: Question;
    value: unknown;
    onChange: (v: unknown) => void;
}) {
    const t = useTranslations('vendorAssessment');
    const tc = useTranslations('common');
    const baseLabel = (
        <label className="block text-sm font-medium text-gray-900 mb-1">
            {question.prompt}
            {question.required && <RequiredMarker />}
        </label>
    );

    switch (question.answerType) {
        case 'YES_NO':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="flex gap-default">
                        {['yes', 'no'].map((opt) => (
                            <label
                                key={opt}
                                className="inline-flex items-center text-sm text-gray-800"
                            >
                                <input
                                    type="radio"
                                    name={question.id}
                                    value={opt}
                                    checked={value === opt}
                                    onChange={() => onChange(opt)}
                                    className="mr-2"
                                />
                                {opt === 'yes' ? tc('yes') : tc('no')}
                            </label>
                        ))}
                    </div>
                </div>
            );

        case 'TEXT':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <textarea
                        value={typeof value === 'string' ? value : ''}
                        onChange={(e) => onChange(e.target.value)}
                        rows={4}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    />
                </div>
            );

        case 'NUMBER':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <input
                        type="text"
                        inputMode="decimal"
                        pattern="-?[0-9]*\.?[0-9]*"
                        value={typeof value === 'number' ? String(value) : ''}
                        onChange={(e) => {
                            const txt = e.target.value;
                            if (txt === '') return onChange(null);
                            const n = Number(txt);
                            onChange(Number.isFinite(n) ? n : null);
                        }}
                        className="border border-gray-300 rounded-md px-3 py-2 text-sm w-40"
                    />
                </div>
            );

        case 'SCALE': {
            const cfg = question.scaleConfigJson as
                | { min?: number; max?: number; labels?: string[] }
                | null;
            const min = cfg?.min ?? 1;
            const max = cfg?.max ?? 5;
            const labels = cfg?.labels;
            const cur = typeof value === 'number' ? value : null;
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="flex items-center gap-tight">
                        {Array.from(
                            { length: max - min + 1 },
                            (_, i) => i + min,
                        ).map((n) => (
                            <button
                                key={n}
                                type="button"
                                onClick={() => onChange(n)}
                                className={`w-9 h-9 rounded-full border text-sm ${
                                    cur === n
                                        ? 'bg-indigo-600 text-white border-indigo-600'
                                        : 'bg-white text-gray-800 border-gray-300'
                                }`}
                            >
                                {n}
                            </button>
                        ))}
                    </div>
                    {labels && labels.length >= 2 && (
                        <div className="flex justify-between text-xs text-gray-500 mt-1 max-w-xs">
                            <span>{labels[0]}</span>
                            <span>{labels[labels.length - 1]}</span>
                        </div>
                    )}
                </div>
            );
        }

        case 'SINGLE_SELECT':
        case 'MULTI_SELECT': {
            const opts = Array.isArray(question.optionsJson)
                ? (question.optionsJson as Array<{
                      label: string;
                      value: string;
                  }>)
                : [];
            const isMulti = question.answerType === 'MULTI_SELECT';
            const arrValue = Array.isArray(value)
                ? (value as string[])
                : [];
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <div className="space-y-1">
                        {opts.map((o) => {
                            const checked = isMulti
                                ? arrValue.includes(o.value)
                                : value === o.value;
                            return (
                                <label
                                    key={o.value}
                                    className="flex items-center text-sm text-gray-800"
                                >
                                    <input
                                        type={isMulti ? 'checkbox' : 'radio'}
                                        name={question.id}
                                        value={o.value}
                                        checked={checked}
                                        onChange={() => {
                                            if (isMulti) {
                                                const next = checked
                                                    ? arrValue.filter(
                                                          (v) => v !== o.value,
                                                      )
                                                    : [...arrValue, o.value];
                                                onChange(next);
                                            } else {
                                                onChange(o.value);
                                            }
                                        }}
                                        className="mr-2"
                                    />
                                    {o.label}
                                </label>
                            );
                        })}
                    </div>
                </div>
            );
        }

        case 'FILE_UPLOAD':
            return (
                <div data-testid={`q-${question.id}`}>
                    {baseLabel}
                    <p className="text-xs text-gray-500 italic">
                        {t('fileUploadNote')}
                    </p>
                    <textarea
                        value={typeof value === 'string' ? value : ''}
                        onChange={(e) => onChange(e.target.value)}
                        rows={2}
                        placeholder={t('fileUploadPlaceholder')}
                        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm mt-1"
                    />
                </div>
            );
    }
}

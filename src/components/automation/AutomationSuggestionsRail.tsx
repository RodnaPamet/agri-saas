'use client';

/**
 * AI automation-rule suggestions rail (Visual Rule Editor VR-9).
 *
 * Designed for the Practice-page right rail (mounted inside an <AsidePanel>).
 * Fetches ranked, posture-aware automation suggestions and lets the user
 * spin one up as a DRAFT rule in one click (then refine it in the builder).
 *
 * Mirrors the AiAssistRail content-not-chrome contract: the page owns the
 * <AsidePanel> wrapper; this component owns the list + actions.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSession } from 'next-auth/react';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Button } from '@/components/ui/button';
import { Sparkle3 } from '@/components/ui/icons/nucleo/sparkle3';

interface RuleSuggestion {
    id: string;
    rank: number;
    title: string;
    rationale: string;
    triggerEvent: string;
    actionType: 'NOTIFY_USER' | 'CREATE_TASK';
    confidenceScore: number;
}

function humanizeEvent(name: string): string {
    return name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/** A minimal VALID action config so the created rule passes the create schema;
 * the user refines recipients / task fields in the builder afterwards. */
function draftConfig(s: RuleSuggestion, currentUserId: string): Record<string, unknown> {
    return s.actionType === 'NOTIFY_USER'
        ? { userIds: [currentUserId], message: s.title }
        : { title: s.title };
}

export function AutomationSuggestionsRail() {
    const t = useTranslations('automationSuggestions');
    const { data: session } = useSession();
    const currentUserId = session?.user?.id ?? '';
    const apiUrl = useTenantApiUrl();
    const { data, isLoading } = useTenantSWR<{ suggestions: RuleSuggestion[] }>(
        CACHE_KEYS.automation.suggestions(),
    );
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    const [applied, setApplied] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<string | null>(null);

    async function createRule(s: RuleSuggestion) {
        setBusy(s.id);
        try {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.list()), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: s.title,
                    triggerEvent: s.triggerEvent,
                    actionType: s.actionType,
                    actionConfig: draftConfig(s, currentUserId),
                    status: 'DRAFT',
                }),
            });
            if (res.ok) setApplied((prev) => new Set(prev).add(s.id));
        } finally {
            setBusy(null);
        }
    }

    const suggestions = (data?.suggestions ?? []).filter((s) => !dismissed.has(s.id));

    return (
        <div className="space-y-default" data-testid="automation-suggestions-rail">
            <p className="text-xs text-content-muted">
                {t('intro')}
            </p>

            {isLoading && (
                <p className="text-xs text-content-subtle">{t('analysing')}</p>
            )}

            {!isLoading && suggestions.length === 0 && (
                <p className="text-xs text-content-subtle">
                    {t('noSuggestions')}
                </p>
            )}

            <ul className="space-y-default">
                {suggestions.map((s) => (
                    <li
                        key={s.id}
                        className="rounded-[10px] border border-border-subtle bg-bg-subtle/40 p-3 space-y-tight"
                        data-suggestion-id={s.id}
                    >
                        <div className="flex items-start gap-tight">
                            <Sparkle3 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-content-muted" />
                            <span className="text-sm font-medium text-content-emphasis">
                                {s.title}
                            </span>
                        </div>
                        <p className="text-xs text-content-muted">{s.rationale}</p>
                        <div className="flex items-center gap-tight">
                            <span className="inline-flex items-center rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] text-content-muted">
                                {humanizeEvent(s.triggerEvent)}
                            </span>
                            {/* confidence bar */}
                            <span className="h-1 flex-1 overflow-hidden rounded-full bg-bg-muted">
                                <span
                                    className="block h-full bg-brand-default"
                                    style={{ width: `${Math.round(s.confidenceScore * 100)}%` }}
                                />
                            </span>
                        </div>
                        <div className="flex items-center gap-tight pt-1">
                            {applied.has(s.id) ? (
                                <span className="text-[11px] text-content-success">{t('draftCreated')}</span>
                            ) : (
                                <>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy === s.id}
                                        onClick={() => createRule(s)}
                                    >
                                        {t('createDraft')}
                                    </Button>
                                    <button
                                        type="button"
                                        className="text-[11px] text-content-subtle hover:text-content-muted"
                                        onClick={() =>
                                            setDismissed((prev) => new Set(prev).add(s.id))
                                        }
                                    >
                                        {t('dismiss')}
                                    </button>
                                </>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    );
}

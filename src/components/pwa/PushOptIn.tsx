'use client';

/**
 * PushOptIn — opt-in toggle for Web Push field alerts (task assignment,
 * spray-window). Permission-graceful at every step:
 *   - Hidden unless the browser supports SW + PushManager AND the server
 *     published a VAPID public key.
 *
 * ## The key arrives as a PROP, read at request time — P7.4 (#1993)
 *
 * It was read off `process.env` under the `NEXT_PUBLIC_` prefix, which
 * `next build` inlines. That value reached no Dockerfile `ARG`, so every
 * image baked `undefined`, so `supported` was false, so this control rendered as
 * unsupported in production for its whole life — measured 2026-10-20: neither
 * VAPID variable set in the container, and zero `platform='WEB'` rows ever
 * created. The same trap #1982 found for the SSE flag, in the same shape.
 *
 * A prop from a server component rather than a fetch, because this panel is
 * the OFFLINE surface: a fetched key is unavailable exactly when the operator
 * is in a field with no signal, while a prop travels in the payload the
 * service worker already caches with the page. It also means configuring web
 * push is an env change and a container restart, with no rebuild — which is
 * what "served at runtime" has to mean for it not to rot again.
 *   - Requests Notification permission only on an explicit tap.
 *   - A denied permission shows a quiet "blocked" state, never nags.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { apiPost } from '@/lib/api-client';

/** VAPID public key (base64url) → Uint8Array for `applicationServerKey`. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    // Allocate over an explicit ArrayBuffer so the type is
    // Uint8Array<ArrayBuffer> (PushManager's applicationServerKey rejects the
    // ArrayBufferLike default).
    const out = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

type Status = 'idle' | 'subscribing' | 'subscribed' | 'denied' | 'error';

export function PushOptIn({
    className,
    vapidPublicKey,
}: {
    className?: string;
    /**
     * The server's VAPID public key, or null when web push is unconfigured.
     *
     * Required rather than optional, and nullable rather than absent: an
     * optional prop would let a caller forget it and get the old silent
     * "unsupported" behaviour back, which is the defect this change exists to
     * remove. Passing `null` is how a deployment says "off", and it has to be
     * said explicitly.
     */
    vapidPublicKey: string | null;
}) {
    const t = useTranslations('pushOptIn');
    const buildUrl = useTenantApiUrl();
    const [supported, setSupported] = useState(false);
    const [status, setStatus] = useState<Status>('idle');

    useEffect(() => {
        const ok =
            typeof window !== 'undefined' &&
            'serviceWorker' in navigator &&
            'PushManager' in window &&
            typeof Notification !== 'undefined' &&
            !!vapidPublicKey;
        setSupported(ok);
        if (!ok) return;
        if (Notification.permission === 'denied') {
            setStatus('denied');
            return;
        }
        // Already subscribed in this browser? Reflect it.
        navigator.serviceWorker.ready
            .then((reg) => reg.pushManager.getSubscription())
            .then((sub) => {
                if (sub) setStatus('subscribed');
            })
            .catch(() => {});
    }, [vapidPublicKey]);

    const enable = useCallback(async () => {
        if (!vapidPublicKey) return;
        setStatus('subscribing');
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                setStatus('denied');
                return;
            }
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                // Cast: the bytes are a valid BufferSource at runtime; the
                // lib's Uint8Array<ArrayBuffer> narrowing is overly strict.
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
            });
            const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
            await apiPost(buildUrl('/push-subscriptions'), {
                endpoint: json.endpoint,
                keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
            });
            setStatus('subscribed');
        } catch {
            setStatus('error');
        }
    }, [buildUrl]);

    if (!supported) return null;
    if (status === 'subscribed') {
        return (
            <span data-testid="push-subscribed" className={className}>
                <span className="text-xs text-content-muted">{t('alertsOn')}</span>
            </span>
        );
    }
    return (
        <Button
            variant="secondary"
            size="sm"
            className={className}
            onClick={() => void enable()}
            disabled={status === 'subscribing' || status === 'denied'}
            data-testid="push-optin"
        >
            {status === 'denied' ? t('alertsBlocked') : status === 'subscribing' ? t('enabling') : t('enableAlerts')}
        </Button>
    );
}

export default PushOptIn;

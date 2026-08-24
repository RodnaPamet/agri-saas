'use client';

/**
 * On-device offline diagnostics — the INSTRUMENT for issue #648.
 *
 * ## Why this exists
 *
 * #648 asks six questions that can only be answered on a physical iPhone, and
 * it has sat open since 2026-08-18 while being nobody's fault: the probes are
 * written as "confirm from the SW's own logging or cache contents", which means
 * Safari devtools, on a phone, at night, one-handed. It is not blocked on
 * hardware so much as on ergonomics.
 *
 * The neighbouring measurement (#650 / #745) succeeded precisely because an
 * instrument shipped first — "queue one entry offline, read the answer off the
 * phone". This is that, for the remaining five probes: open a URL, screenshot
 * it, or press Copy and paste into the issue.
 *
 * ## Three constraints this page is built around, all measured on a real device
 *
 * 1. **A bookmarklet cannot reach an installed PWA.** Standalone mode has no
 *    bookmarks UI, and iOS gives the installed app its own storage jar. So the
 *    instrument has to be a URL-addressable ROUTE inside the app — which is why
 *    this is a page and not a devtools snippet.
 *
 * 2. **The existing durability signal is NEGATIVE-ONLY.** `OfflineSyncBar`
 *    renders only when `pending > 0 && storagePersisted === false`, and
 *    `offline-storage-verdict` lives inside the LOST-WORK banner — i.e. it
 *    requires work to have already been destroyed. On screen today, "granted",
 *    "never measured" and "nothing queued yet" are indistinguishable. This page
 *    therefore shows the verdict in EVERY state, including absent.
 *
 * 3. **Display mode predicts durability.** Measured 2026-08-23: mobile Safari
 *    REFUSES `persist()`; the installed Home Screen PWA GRANTS it. So the
 *    browsing context is not a footnote — it is the variable — and it is shown
 *    first, next to the verdict it explains.
 *
 * ## What this page does NOT do
 *
 * It does not call `persist()`. `requestPersistence()` is armed once per PAGE
 * LOAD at first enqueue (module-scoped flag), so measuring here would produce a
 * second, different answer and muddy the one the app actually stored. Every
 * durability field below is READ from `agri.offline.durability.v1`, and the page
 * says so where an operator will read it.
 *
 * Not linked from any navigation: it is an instrument, not product UI.
 */
import * as React from 'react';
import {
    DURABILITY_STORAGE_KEY,
    LOST_WORK_STORAGE_KEY,
    MANIFEST_STORAGE_KEY,
    readDurabilityVerdict,
    readLostWork,
    readManifest,
    type DurabilityVerdict,
    type LostWorkRecord,
} from '@/lib/offline/durability';
import { getOutboxSnapshot, refreshOutboxState, type OutboxSnapshot } from '@/lib/offline/outbox-state';
import { isIos, isStandalone } from '@/lib/pwa/display-mode';
import { Button } from '@/components/ui/button';

/**
 * The four caches `public/sw.js` declares, by SUFFIX. #648 probe 2 asks for
 * each BY NAME, so they are listed explicitly rather than counted — "four
 * caches exist" is a different claim from "PAGE_CACHE exists".
 *
 * Matched on suffix, not on the full `agrent-v1-*` string, so a CACHE_VERSION
 * bump does not silently turn every row into "missing".
 */
const EXPECTED_CACHES = [
    { key: 'STATIC_CACHE', suffix: '-static', role: 'app shell' },
    { key: 'PAGE_CACHE', suffix: '-pages', role: 'serves the offline cold launch' },
    { key: 'DATA_CACHE', suffix: '-fielddata', role: 'tenant field data' },
    { key: 'BASEMAP_CACHE', suffix: '-basemap', role: 'offline map tiles' },
] as const;

interface CacheRow {
    key: string;
    suffix: string;
    role: string;
    name: string | null;
    entries: number | null;
}

interface SwState {
    supported: boolean;
    controlled: boolean;
    scope: string | null;
    activeState: string | null;
    waiting: boolean;
}

interface Diagnostics {
    caches: CacheRow[] | null;
    sw: SwState | null;
    estimate: { quota?: number; usage?: number } | null;
    outbox: OutboxSnapshot | null;
    verdict: DurabilityVerdict | null;
    lost: LostWorkRecord | null;
    manifestCount: number | null;
    ranAt: string;
}

/**
 * Collect everything, then commit ONE state object.
 *
 * Deliberately not eight `setState` calls: that renders the page eight times
 * on every collection, and setting state synchronously inside the effect body
 * triggers the cascading-render lint rule. Gathering into a local and
 * committing once is both fewer renders and a consistent snapshot — a
 * half-updated diagnostics page is a misleading one.
 */
async function collectDiagnostics(): Promise<Diagnostics> {
    const out: Diagnostics = {
        caches: null,
        sw: null,
        estimate: null,
        outbox: null,
        verdict: readDurabilityVerdict(),
        lost: readLostWork(),
        manifestCount: null,
        ranAt: new Date().toISOString(),
    };

    try {
        out.manifestCount = readManifest().length;
    } catch {
        out.manifestCount = null;
    }

    try {
        await refreshOutboxState();
    } catch {
        /* an unreadable outbox is itself a finding — fall through to the snapshot */
    }
    out.outbox = getOutboxSnapshot();

    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        try {
            const reg = await navigator.serviceWorker.getRegistration();
            out.sw = {
                supported: true,
                controlled: Boolean(navigator.serviceWorker.controller),
                scope: reg?.scope ?? null,
                activeState: reg?.active?.state ?? null,
                waiting: Boolean(reg?.waiting),
            };
        } catch {
            out.sw = { supported: true, controlled: false, scope: null, activeState: null, waiting: false };
        }
    } else {
        out.sw = { supported: false, controlled: false, scope: null, activeState: null, waiting: false };
    }

    if (typeof globalThis.caches !== 'undefined') {
        try {
            const names = await globalThis.caches.keys();
            out.caches = await Promise.all(
                EXPECTED_CACHES.map(async (spec) => {
                    const name = names.find((n) => n.endsWith(spec.suffix)) ?? null;
                    let entries: number | null = null;
                    if (name) {
                        try {
                            entries = (await (await globalThis.caches.open(name)).keys()).length;
                        } catch {
                            entries = null;
                        }
                    }
                    return { ...spec, name, entries };
                }),
            );
        } catch {
            out.caches = null;
        }
    }

    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        try {
            const e = await navigator.storage.estimate();
            out.estimate = { quota: e.quota, usage: e.usage };
        } catch {
            out.estimate = null;
        }
    }

    return out;
}

function useDiagnostics() {
    const [data, setData] = React.useState<Diagnostics | null>(null);

    const recollect = React.useCallback(() => {
        void collectDiagnostics().then(setData);
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        void collectDiagnostics().then((d) => {
            if (!cancelled) setData(d);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return { data, recollect };
}

function mb(n: number | undefined): string {
    if (n === undefined) return '—';
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
    return (
        <div className="flex flex-col gap-tight border-b border-border-subtle py-compact sm:flex-row sm:items-baseline sm:justify-between">
            <div className="flex flex-col">
                <span className="font-mono text-sm text-content-default">{label}</span>
                {hint ? <span className="text-xs text-content-muted">{hint}</span> : null}
            </div>
            <span className="font-mono text-sm text-content-default sm:text-right">{value}</span>
        </div>
    );
}

function Section({ probe, title, children }: { probe: string; title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-default rounded-lg border border-border-subtle p-default">
            <header className="space-y-tight">
                <span className="font-mono text-xs uppercase tracking-wide text-content-muted">{probe}</span>
                <h2 className="text-base font-semibold text-content-default">{title}</h2>
            </header>
            <div>{children}</div>
        </section>
    );
}

export default function OfflineDiagnosticsPage() {
    const { data, recollect } = useDiagnostics();
    const caches_ = data?.caches ?? null;
    const sw = data?.sw ?? null;
    const estimate = data?.estimate ?? null;
    const outbox = data?.outbox ?? null;
    const verdict = data?.verdict ?? null;
    const lost = data?.lost ?? null;
    const manifestCount = data?.manifestCount ?? null;
    const ranAt = data?.ranAt ?? '';
    const [copied, setCopied] = React.useState(false);

    const standalone = typeof window !== 'undefined' ? isStandalone() : false;
    const ios = typeof window !== 'undefined' ? isIos() : false;

    const asText = React.useMemo(() => {
        const lines: string[] = [];
        lines.push(`# offline diagnostics — ${ranAt}`);
        lines.push(`ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`);
        lines.push(`displayMode: ${standalone ? 'standalone (installed PWA)' : 'browser tab'}  ios: ${ios}`);
        lines.push('');
        lines.push('## durability (READ from localStorage, not re-measured)');
        lines.push(verdict ? JSON.stringify(verdict) : 'NO VERDICT STORED — nothing has been queued on this device yet');
        lines.push(`estimate: quota=${estimate?.quota ?? '?'} usage=${estimate?.usage ?? '?'}`);
        lines.push('');
        lines.push('## service worker');
        lines.push(JSON.stringify(sw));
        lines.push('');
        lines.push('## caches (probe 2 — by name)');
        for (const c of caches_ ?? []) {
            lines.push(`${c.key.padEnd(14)} ${c.name ?? 'MISSING'}  entries=${c.entries ?? '?'}`);
        }
        if (caches_ === null) lines.push('Cache Storage unavailable in this context');
        lines.push('');
        lines.push('## outbox');
        lines.push(
            outbox
                ? `pending=${outbox.pending} photos=${outbox.pendingPhotos} foreign=${outbox.foreign} conflicts=${outbox.conflicts.length} queueGrowing=${outbox.queueGrowing}`
                : 'unavailable',
        );
        lines.push(`manifestEntries: ${manifestCount ?? '?'}`);
        lines.push(`lostWork: ${lost ? JSON.stringify(lost) : 'none'}`);
        return lines.join('\n');
    }, [ranAt, standalone, ios, verdict, estimate, sw, caches_, outbox, manifestCount, lost]);

    const copy = React.useCallback(async () => {
        try {
            await navigator.clipboard.writeText(asText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    }, [asText]);

    return (
        <div className="space-y-section p-default">
            <header className="space-y-tight">
                <h1 className="text-lg font-semibold text-content-default">Offline diagnostics</h1>
                <p className="text-sm text-content-muted">
                    Instrument for issue #648. Screenshot this page, or press Copy and paste the text into the issue.
                    Not linked from navigation — reach it by URL.
                </p>
                <p className="font-mono text-xs text-content-muted">collected {ranAt || '…'}</p>
            </header>

            <div className="flex flex-wrap gap-compact">
                <Button variant="secondary" onClick={recollect} text="Re-collect" />
                <Button
                    variant="secondary"
                    onClick={() => void copy()}
                    text={copied ? 'Copied' : 'Copy as text'}
                />
            </div>

            <Section probe="context" title="Browsing context">
                {/* Shown FIRST because it is the variable that predicts the verdict
                    below: measured 2026-08-23, Safari refuses persist(), the
                    installed PWA grants it. */}
                <Row
                    label="displayMode"
                    value={standalone ? 'standalone (installed PWA)' : 'browser tab'}
                    hint="installed PWA is granted persistence; mobile Safari is refused"
                />
                <Row label="iOS" value={String(ios)} />
                <Row
                    label="userAgent"
                    value={
                        <span className="break-all">
                            {typeof navigator !== 'undefined' ? navigator.userAgent : '—'}
                        </span>
                    }
                />
            </Section>

            <Section probe="probe 6 · storage" title="Durability verdict">
                <p className="pb-compact text-xs text-content-muted">
                    Read from <span className="font-mono">{DURABILITY_STORAGE_KEY}</span>. This page does not call
                    persist() — that is armed once per page load at first enqueue, so measuring here would produce a
                    second, different answer.
                </p>
                {verdict ? (
                    <>
                        <Row label="supported" value={String(verdict.supported)} />
                        <Row label="persisted" value={String(verdict.persisted)} hint="navigator.storage.persisted()" />
                        <Row label="requested" value={String(verdict.requested)} />
                        <Row label="quota" value={mb(verdict.quota)} />
                        <Row label="usage" value={mb(verdict.usage)} />
                        <Row label="at" value={verdict.at} />
                    </>
                ) : (
                    <Row
                        label="verdict"
                        value="NONE STORED"
                        hint="nothing has been queued on this device yet — queue one entry offline first"
                    />
                )}
                <Row label="estimate.quota (live)" value={mb(estimate?.quota)} />
                <Row label="estimate.usage (live)" value={mb(estimate?.usage)} />
            </Section>

            <Section probe="probe 1" title="Service worker">
                {sw ? (
                    <>
                        <Row label="supported" value={String(sw.supported)} />
                        <Row
                            label="controlled"
                            value={String(sw.controlled)}
                            hint="true means a SW is actually serving this page, not merely registered"
                        />
                        <Row label="scope" value={sw.scope ?? '—'} />
                        <Row label="active.state" value={sw.activeState ?? '—'} />
                        <Row label="waiting" value={String(sw.waiting)} />
                    </>
                ) : (
                    <Row label="serviceWorker" value="collecting…" />
                )}
            </Section>

            <Section probe="probe 2" title="Caches, by name">
                {caches_ === null ? (
                    <Row label="CacheStorage" value="UNAVAILABLE" hint="no caches API in this context" />
                ) : (
                    caches_.map((c) => (
                        <Row
                            key={c.key}
                            label={c.key}
                            hint={`${c.role}${c.name ? ` · ${c.name}` : ''}`}
                            value={c.name ? `${c.entries ?? '?'} entries` : 'MISSING'}
                        />
                    ))
                )}
            </Section>

            <Section probe="probes 4 · 6" title="Outbox">
                {outbox ? (
                    <>
                        <Row label="pending" value={String(outbox.pending)} />
                        <Row label="pendingPhotos" value={String(outbox.pendingPhotos)} />
                        <Row
                            label="foreign"
                            value={String(outbox.foreign)}
                            hint="queued by a different operator — never sent, never dropped"
                        />
                        <Row label="conflicts" value={String(outbox.conflicts.length)} />
                        <Row label="queueGrowing" value={String(outbox.queueGrowing)} />
                    </>
                ) : (
                    <Row label="outbox" value="collecting…" />
                )}
                <Row
                    label="manifest entries"
                    value={String(manifestCount ?? '?')}
                    hint={MANIFEST_STORAGE_KEY}
                />
                <Row
                    label="lost work"
                    value={lost ? `${lost.entries.length} · ${lost.cause}` : 'none'}
                    hint={lost ? `${LOST_WORK_STORAGE_KEY} · detected ${lost.detectedAt}` : LOST_WORK_STORAGE_KEY}
                />
            </Section>
        </div>
    );
}

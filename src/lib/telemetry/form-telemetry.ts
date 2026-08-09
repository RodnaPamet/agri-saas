"use client";

/**
 * Client-side form telemetry.
 *
 * Every Epic 54/55-migrated form is a customer-observable surface:
 * failures, abandonment patterns, and latency are the core signals a
 * support / product / engineering team needs after incidents. This
 * module provides a single hook that instruments any form with:
 *
 *   - `open` — the form (modal/sheet/page) mounted.
 *   - `submit` — submit button pressed.
 *   - `success` — submit resolved OK.
 *   - `error` — submit resolved with an error.
 *   - `abandon` — mount → unmount without a success.
 *
 * Events are dispatched to a single global sink that an app can wire
 * to Sentry breadcrumbs, PostHog, a server-log endpoint, etc. — via
 * `registerFormTelemetrySink(handler)` at app boot. When no sink is
 * registered the events are a no-op in production; in development
 * they're forwarded to `console.debug` for local visibility.
 *
 * Zero hard dependencies on Sentry / PostHog / any specific analytics
 * library. The sink pattern keeps the primitives library-safe.
 */

import * as React from "react";

export interface FormTelemetryEvent {
    type: "open" | "submit" | "success" | "error" | "abandon";
    /**
     * Stable identifier of the form surface (e.g., "NewPracticeModal",
     * "UploadEvidenceModal"). Appears as the primary dimension on the
     * reporting side.
     */
    surface: string;
    /** Milliseconds since the form was opened. */
    durationMs?: number;
    /** Arbitrary extra fields the caller wants to record. */
    fields?: Record<string, unknown>;
    /** Error subject when type === "error". */
    error?: {
        message: string;
        code?: string | number;
    };
}

export type FormTelemetrySink = (event: FormTelemetryEvent) => void;

// ─── Sink registration ──────────────────────────────────────────

let registeredSink: FormTelemetrySink | null = null;

/**
 * Register a global handler that receives every form telemetry event.
 * Apps typically call this once, at boot, from a client-side provider
 * (e.g. forwarding to Sentry.addBreadcrumb + analytics.track).
 */
export function registerFormTelemetrySink(sink: FormTelemetrySink): void {
    registeredSink = sink;
}

/**
 * Internal dispatch. Exposes test / debug override via window-scoped
 * hook so Storybook / Playwright can observe events without routing
 * through the registered sink.
 */
export function emitFormTelemetry(event: FormTelemetryEvent): void {
    if (typeof window !== "undefined") {
        const debug = (
            window as unknown as {
                __INFLECT_FORM_TELEMETRY__?: FormTelemetrySink;
            }
        ).__INFLECT_FORM_TELEMETRY__;
        if (debug) {
            try {
                debug(event);
            } catch {
                // Debug hook errors must never bubble.
            }
        }
    }
    if (registeredSink) {
        try {
            registeredSink(event);
        } catch {
            // Sink errors must never bubble into the user-facing form.
        }
    }
    // When no sink is registered the event is a no-op. Apps wire the
    // sink once at boot via `registerFormTelemetrySink()`; for local
    // debugging the `window.__INFLECT_FORM_TELEMETRY__` debug hook
    // above lets test harnesses observe events without a real sink.
}

// ─── Hook ───────────────────────────────────────────────────────

export interface FormTelemetryHandle {
    /** Call from onSubmit start; returns a deadline for success/error. */
    trackSubmit(fields?: Record<string, unknown>): void;
    /** Call when the submit promise resolves OK. */
    trackSuccess(fields?: Record<string, unknown>): void;
    /** Call when the submit promise rejects / response is non-OK. */
    trackError(
        error: unknown,
        fields?: Record<string, unknown>,
    ): void;
}

/**
 * Instrument a form surface with lifecycle telemetry.
 *
 *     const tel = useFormTelemetry("UploadEvidenceModal");
 *     // tel.trackSubmit() at the start of onSubmit
 *     // tel.trackSuccess() inside onSuccess
 *     // tel.trackError(err) inside onError
 *
 * The hook auto-emits `open` on mount and `abandon` on unmount when
 * no success was recorded.
 */
export function useFormTelemetry(surface: string): FormTelemetryHandle {
    const mountedAtRef = React.useRef(0);
    const successRef = React.useRef(false);

    React.useEffect(() => {
        mountedAtRef.current = Date.now();
        emitFormTelemetry({ type: "open", surface });
        return () => {
            if (!successRef.current) {
                emitFormTelemetry({
                    type: "abandon",
                    surface,
                    durationMs: Date.now() - mountedAtRef.current,
                });
            }
        };
        // Surface is expected to be a stable string literal; re-running
        // on change would be wrong (would re-fire open).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return React.useMemo<FormTelemetryHandle>(
        () => ({
            trackSubmit(fields) {
                emitFormTelemetry({
                    type: "submit",
                    surface,
                    durationMs: Date.now() - mountedAtRef.current,
                    fields,
                });
            },
            trackSuccess(fields) {
                successRef.current = true;
                emitFormTelemetry({
                    type: "success",
                    surface,
                    durationMs: Date.now() - mountedAtRef.current,
                    fields,
                });
            },
            trackError(error, fields) {
                const message =
                    error instanceof Error
                        ? error.message
                        : typeof error === "string"
                          ? error
                          : "Unknown error";
                const code =
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    (typeof (error as { code: unknown }).code === "string" ||
                        typeof (error as { code: unknown }).code === "number")
                        ? (error as { code: string | number }).code
                        : undefined;
                emitFormTelemetry({
                    type: "error",
                    surface,
                    durationMs: Date.now() - mountedAtRef.current,
                    fields,
                    error: { message, code },
                });
            },
        }),
        [surface],
    );
}

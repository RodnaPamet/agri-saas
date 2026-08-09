/**
 * @jest-environment jsdom
 *
 * Form telemetry hook contract.
 *
 *   - Registers a sink that receives every lifecycle event.
 *   - Emits `open` on mount, `abandon` on unmount without success.
 *   - Suppresses `abandon` when a success was recorded.
 *   - Tolerates sink throws without re-raising into React.
 */

import { act, renderHook } from '@testing-library/react';
import {
    registerFormTelemetrySink,
    type FormTelemetryEvent,
    useFormTelemetry,
} from '@/lib/telemetry/form-telemetry';

describe('useFormTelemetry', () => {
    let events: FormTelemetryEvent[];

    beforeEach(() => {
        events = [];
        registerFormTelemetrySink((e) => events.push(e));
    });

    afterEach(() => {
        // Clear the sink between tests so other files aren't polluted.
        registerFormTelemetrySink(() => {});
    });

    it('emits `open` on mount', () => {
        renderHook(() => useFormTelemetry('Demo'));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'open', surface: 'Demo' });
    });

    it('emits `submit` with durationMs + fields', () => {
        const { result } = renderHook(() => useFormTelemetry('Demo'));
        act(() => {
            result.current.trackSubmit({ practiceId: 'abc' });
        });
        const submit = events.find((e) => e.type === 'submit');
        expect(submit).toBeDefined();
        expect(submit?.surface).toBe('Demo');
        expect(submit?.fields).toEqual({ practiceId: 'abc' });
        expect(typeof submit?.durationMs).toBe('number');
    });

    it('emits `success` and suppresses subsequent `abandon` on unmount', () => {
        const { result, unmount } = renderHook(() =>
            useFormTelemetry('Demo'),
        );
        act(() => {
            result.current.trackSuccess();
        });
        unmount();
        const types = events.map((e) => e.type);
        expect(types).toContain('success');
        expect(types).not.toContain('abandon');
    });

    it('emits `abandon` on unmount when no success was recorded', () => {
        const { unmount } = renderHook(() => useFormTelemetry('Demo'));
        unmount();
        const types = events.map((e) => e.type);
        expect(types).toContain('abandon');
    });

    it('emits `error` with message + code extracted from thrown Error', () => {
        const { result } = renderHook(() => useFormTelemetry('Demo'));
        const err = Object.assign(new Error('Conflict'), { code: 409 });
        act(() => {
            result.current.trackError(err);
        });
        const e = events.find((x) => x.type === 'error');
        expect(e?.error).toEqual({ message: 'Conflict', code: 409 });
    });

    it('falls back gracefully on string or unknown errors', () => {
        const { result } = renderHook(() => useFormTelemetry('Demo'));
        act(() => {
            result.current.trackError('text error');
            result.current.trackError({ weird: 'shape' });
        });
        const errs = events.filter((e) => e.type === 'error');
        expect(errs[0]?.error?.message).toBe('text error');
        expect(errs[1]?.error?.message).toBe('Unknown error');
    });

    it('sink throws never bubble out', () => {
        registerFormTelemetrySink(() => {
            throw new Error('sink boom');
        });
        // Should not throw during render/unmount.
        expect(() => {
            const { unmount } = renderHook(() => useFormTelemetry('Demo'));
            unmount();
        }).not.toThrow();
    });
});

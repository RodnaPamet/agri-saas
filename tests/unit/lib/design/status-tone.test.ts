/**
 * Polish PR-7 — Status-tone helper unit tests.
 */

import {
    getStatusTone,
    getCategoryTone,
    getIntensityTone,
    bucketIntensity,
} from '@/lib/design/status-tone';

// RQ3-9 — the `score-0-25` scale was removed. Risk-score colouring
// now flows through `resolveBandForScore` (the canonical matrix-
// config band resolver). The tests below pin the surviving scales.

describe('getStatusTone — pct-0-100 scale', () => {
    it('≥80 returns success', () => {
        expect(getStatusTone(80, 'pct-0-100').content).toBe('text-content-success');
        expect(getStatusTone(100, 'pct-0-100').content).toBe('text-content-success');
    });

    it('50..79 returns attention', () => {
        expect(getStatusTone(50, 'pct-0-100').content).toBe('text-content-warning');
        expect(getStatusTone(79, 'pct-0-100').content).toBe('text-content-warning');
    });

    it('<50 returns critical', () => {
        expect(getStatusTone(49, 'pct-0-100').content).toBe('text-content-error');
        expect(getStatusTone(0, 'pct-0-100').content).toBe('text-content-error');
    });

    it('pass-rate-0-100 alias matches pct-0-100', () => {
        for (const v of [0, 49, 50, 79, 80, 100]) {
            expect(getStatusTone(v, 'pass-rate-0-100')).toEqual(
                getStatusTone(v, 'pct-0-100'),
            );
        }
    });
});

describe('getStatusTone — count-attention scale', () => {
    it('value=0 returns neutral', () => {
        const t = getStatusTone(0, { kind: 'count-attention', criticalAt: 5 });
        expect(t.content).toBe('text-content-muted');
    });

    it('1..criticalAt-1 returns attention', () => {
        const t = getStatusTone(3, { kind: 'count-attention', criticalAt: 5 });
        expect(t.content).toBe('text-content-warning');
    });

    it('≥criticalAt returns critical', () => {
        const t = getStatusTone(5, { kind: 'count-attention', criticalAt: 5 });
        expect(t.content).toBe('text-content-error');
    });
});

describe('getCategoryTone', () => {
    it('returns a tone bundle for every category', () => {
        const cats = [
            'evidence',
            'policy',
            'vendor',
            'audit',
            'practice',
            'task',
            'risk',
            'finding',
        ] as const;
        for (const c of cats) {
            const t = getCategoryTone(c);
            expect(t.bg).toBeTruthy();
            expect(t.content).toBeTruthy();
            expect(t.border).toBeTruthy();
        }
    });

    it('practice returns success-toned bg', () => {
        expect(getCategoryTone('practice').bg).toBe('bg-status-success');
    });

    it('risk returns danger-toned bg', () => {
        expect(getCategoryTone('risk').bg).toBe('bg-status-danger');
    });
});

describe('getIntensityTone', () => {
    it('returns a brand-alpha class for each bucket 0-4', () => {
        for (const b of [0, 1, 2, 3, 4] as const) {
            const cls = getIntensityTone(b);
            expect(cls).toBeTruthy();
            expect(typeof cls).toBe('string');
        }
    });

    it('bucket 0 is the muted neutral', () => {
        expect(getIntensityTone(0)).toBe('bg-bg-muted/40');
    });

    it('higher buckets get higher brand alpha', () => {
        // Quick monotonic check on the alpha suffix.
        const alphas = [1, 2, 3, 4]
            .map((b) => getIntensityTone(b as 1 | 2 | 3 | 4))
            .map((s) => parseInt(s.match(/\/(\d+)/)![1], 10));
        for (let i = 1; i < alphas.length; i++) {
            expect(alphas[i]).toBeGreaterThan(alphas[i - 1]);
        }
    });
});

describe('bucketIntensity', () => {
    it('count=0 → 0', () => {
        expect(bucketIntensity(0, 10)).toBe(0);
    });
    it('max=0 → 0', () => {
        expect(bucketIntensity(5, 0)).toBe(0);
    });
    it('count=max → 4', () => {
        expect(bucketIntensity(10, 10)).toBe(4);
    });
    it('quarter density → 1', () => {
        expect(bucketIntensity(2, 10)).toBe(1);
    });
});

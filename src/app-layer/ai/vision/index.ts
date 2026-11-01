/**
 * Vision orchestrator — picks a backend and runs the classification with
 * on-device-first fallback.
 *
 * SERVER-ONLY: re-exports the provider classes (which load native addons /
 * the Anthropic SDK). The UI imports ONLY `PestIdentification` from
 * `./types`, never this module.
 *
 * Policy (`VISION_BACKEND` env, default `auto`):
 *   - `auto`   — try the on-device ONNX model first when it is available;
 *                fall back to Claude when ONNX is unavailable, throws, OR
 *                its confidence is below `FALLBACK_CONFIDENCE`. If neither
 *                backend is available, returns null.
 *   - `onnx`   — pin to the on-device backend (no Claude fallback).
 *   - `claude` — pin to the cloud backend.
 *
 * FAIL-SAFE: `identifyPhoto` returns `null` (never throws) when no
 * backend can produce a result — the caller (classify-photo job) treats
 * null as "no suggestion this time"; the photo + log entry are untouched.
 */
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { OnnxVisionProvider } from './onnx-provider';
import { ClaudeVisionProvider } from './claude-vision-provider';
import type { PestIdentification, VisionImage, VisionProvider } from './types';

export type { PestIdentification, VisionImage, VisionProvider } from './types';
export { OnnxVisionProvider } from './onnx-provider';
export { ClaudeVisionProvider } from './claude-vision-provider';

/**
 * Below this on-device confidence, `auto` re-runs the image through
 * Claude — a low-confidence edge prediction is exactly the case where
 * the cloud model's broader knowledge helps most.
 */
export const FALLBACK_CONFIDENCE = 0.55;

/** A configured provider for an explicitly-pinned backend. */
export function getVisionProvider(backend: 'onnx' | 'claude'): VisionProvider {
    return backend === 'onnx' ? new OnnxVisionProvider() : new ClaudeVisionProvider();
}

async function tryIdentify(
    provider: VisionProvider,
    image: VisionImage,
): Promise<PestIdentification | null> {
    try {
        if (!(await provider.available())) return null;
        return await provider.identify(image);
    } catch (err) {
        logger.warn('vision provider failed', {
            component: 'vision',
            backend: provider.backend,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

export interface IdentifyPhotoOptions {
    /**
     * When `false`, the PAID backend is never reached (#2596).
     *
     * The caller holds the `RequestContext` and is therefore the only place
     * that can know whether this tenant has budget left — which is exactly
     * what `ai-spend-gate-covers-embeddings` exempts the providers on. This
     * is the lever that lets it act on the answer.
     *
     * Defaults to `true`, so every existing caller behaves as before and the
     * refusal is opt-IN. A default of `false` would silently disable the
     * cloud fallback for any future caller that forgot the flag, which is a
     * quality regression disguised as a cost control.
     */
    allowCloud?: boolean;
}

/**
 * Classify a leaf/crop photo. Returns the structured identification, or
 * `null` when no backend produced one (fail-safe).
 */
export async function identifyPhoto(
    image: VisionImage,
    opts: IdentifyPhotoOptions = {},
): Promise<PestIdentification | null> {
    const policy = env.VISION_BACKEND;
    const allowCloud = opts.allowCloud ?? true;

    if (policy === 'onnx') {
        return tryIdentify(new OnnxVisionProvider(), image);
    }
    if (policy === 'claude') {
        /**
         * The only configured backend is the paid one, and the caller says it
         * cannot be paid for. `null` — the honest "no identification" the
         * contract already has for every other unavailable-backend case,
         * which the job renders as inconclusive.
         */
        if (!allowCloud) {
            logger.info('vision cloud withheld — no budget', {
                component: 'vision',
                policy,
            });
            return null;
        }
        return tryIdentify(new ClaudeVisionProvider(), image);
    }

    // auto — on-device first, fall back to Claude on unavailable / failure
    // / low confidence.
    const onnx = new OnnxVisionProvider();
    const onDevice = await tryIdentify(onnx, image);
    if (onDevice && onDevice.confidence >= FALLBACK_CONFIDENCE) {
        return onDevice;
    }

    /**
     * Budget exhausted: KEEP the low-confidence on-device result rather than
     * failing the job.
     *
     * This is the same branch the code already takes when Claude is
     * unavailable or errors, and for the same reason — the job gates low
     * confidence anyway and renders it as "inconclusive, verify with an
     * agronomist". So an out-of-budget farm loses the second opinion, not the
     * whole classification.
     */
    if (!allowCloud) {
        logger.info('vision cloud fallback withheld — no budget', {
            component: 'vision',
            policy,
            hadOnDevice: onDevice != null,
        });
        return onDevice;
    }

    const claude = new ClaudeVisionProvider();
    const cloud = await tryIdentify(claude, image);
    if (cloud) return cloud;

    // Claude unavailable / failed — keep the low-confidence on-device
    // result rather than nothing (the job gates low confidence anyway).
    return onDevice;
}

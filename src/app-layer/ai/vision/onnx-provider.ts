/**
 * On-device / edge vision backend — an ONNX crop-disease classifier run
 * locally via `onnxruntime-node`, with `sharp` for image preprocessing.
 *
 * SERVER-ONLY. `onnxruntime-node` is a native addon and `sharp` is a
 * native image library — neither may ever enter a client bundle. This
 * module is only ever imported from the classify-photo job (server).
 *
 * Model: CropNet / MobileNetV2-PlantVillage (Apache-2.0). The WEIGHTS
 * are NOT vendored — they load from `VISION_MODEL_PATH` (env). When that
 * path is unset or the file is missing, `available()` returns false so
 * the orchestrator falls back to Claude. See THIRD_PARTY_NOTICES.md for
 * the model source + license + setup instructions.
 *
 * Pipeline: bytes → sharp (resize 224×224, RGB, ImageNet normalise) →
 * NCHW Float32 tensor → ORT session → logits → softmax → argmax → label.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import type { InferenceSession, Tensor } from 'onnxruntime-node';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { PLANTVILLAGE_LABELS, isHealthyLabel } from './labels';
import type { PestIdentification, VisionImage, VisionProvider } from './types';

/** Square input edge the model expects (MobileNetV2 / CropNet → 224). */
const INPUT_SIZE = 224;

/** ImageNet channel mean / std — the normalisation MobileNetV2 trained with. */
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** Resolve the configured labels (env override → bundled PlantVillage list). */
function resolveLabels(): readonly string[] {
    const override = env.VISION_LABELS_PATH;
    if (override && existsSync(override)) {
        const lines = readFileSync(override, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length > 0) return lines;
    }
    return PLANTVILLAGE_LABELS;
}

/** Numerically-stable softmax over a logit vector. */
export function softmax(logits: readonly number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    return exps.map((e) => e / sum);
}

/** A short, provisional next-step for a given label. */
function recommendationFor(label: string, healthy: boolean): string {
    if (healthy) {
        return 'No pest or disease detected. Keep monitoring; no action needed beyond routine scouting.';
    }
    return `Possible ${label}. Isolate affected plants, remove obviously infected tissue, and confirm with an agronomist before applying any treatment.`;
}

/**
 * Map a raw logit vector to a structured identification: softmax →
 * argmax → label + confidence. `modelVersion` carries the model id plus
 * a short content hash so the persisted result is traceable to the
 * exact weights that produced it.
 */
export function logitsToIdentification(
    logits: readonly number[],
    labels: readonly string[],
    modelVersion: string,
): PestIdentification {
    const probs = softmax(logits);
    let topIdx = 0;
    for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[topIdx]) topIdx = i;
    }
    const label = labels[topIdx] ?? 'unknown';
    const healthy = isHealthyLabel(label);
    return {
        identifiedPest: healthy ? 'healthy' : label,
        confidence: probs[topIdx] ?? 0,
        recommendation: recommendationFor(label, healthy),
        modelVersion,
        backend: 'onnx',
    };
}

/**
 * Load the native ONNX runtime, or fail in a way an operator can act on.
 *
 * `onnxruntime-node` is an OPTIONAL dependency: its postinstall downloads a
 * platform binary from the network, and a bare `RUN npm ci` in the Dockerfile
 * made every image build depend on that download succeeding first time. One
 * ETIMEDOUT reddened `Docker Build & Scan` on a commit whose diff was a single
 * `scripts` entry. Optional means a failed download no longer fails the build;
 * it also means the module can legitimately be ABSENT at runtime.
 *
 * Absence is unreachable in the current configuration — `getSession` throws on
 * a missing `VISION_MODEL_PATH` before either import site runs, and production
 * sets neither `VISION_MODEL_PATH` nor `VISION_BACKEND` — so this exists for
 * the operator who later supplies a model on an image whose optional install
 * failed. Without it they would get a raw `MODULE_NOT_FOUND` naming a package
 * they never asked for, which reads as a code bug rather than an install one.
 */
async function loadOnnxRuntime(): Promise<typeof import('onnxruntime-node')> {
    try {
        return await import('onnxruntime-node');
    } catch (cause) {
        throw new Error(
            'The ONNX vision backend needs `onnxruntime-node`, which is not installed in ' +
                'this image. It is an OPTIONAL dependency because its postinstall downloads ' +
                'a native binary, so a network failure at build time leaves it absent rather ' +
                'than failing the build. Reinstall it, or set VISION_BACKEND to a provider ' +
                'that does not need it.',
            { cause },
        );
    }
}

export class OnnxVisionProvider implements VisionProvider {
    readonly backend = 'onnx' as const;

    private sessionPromise: Promise<InferenceSession> | null = null;
    private modelVersion: string | null = null;

    /** True when a model file is configured AND present on disk. */
    async available(): Promise<boolean> {
        const path = env.VISION_MODEL_PATH;
        return Boolean(path && existsSync(path));
    }

    private async getSession(): Promise<InferenceSession> {
        if (this.sessionPromise) return this.sessionPromise;
        const path = env.VISION_MODEL_PATH;
        if (!path || !existsSync(path)) {
            throw new Error('VISION_MODEL_PATH is not set or the ONNX model file is missing.');
        }
        // Short content hash → modelVersion suffix, so the persisted
        // result is traceable to the exact weights.
        const bytes = readFileSync(path);
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
        this.modelVersion = `cropnet-v1+${hash}`;

        // Dynamic import keeps the native addon off any module that only
        // needs the TYPES above (the orchestrator + tests can mock it).
        this.sessionPromise = loadOnnxRuntime().then((ort) =>
            ort.InferenceSession.create(path),
        );
        return this.sessionPromise;
    }

    /**
     * Preprocess raw image bytes into an NCHW Float32Array (1×3×224×224)
     * with ImageNet normalisation. Exposed for unit testing.
     */
    async preprocess(image: VisionImage): Promise<Float32Array> {
        const sharp = (await import('sharp')).default;
        const { data } = await sharp(image.bytes)
            .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixels = INPUT_SIZE * INPUT_SIZE;
        const out = new Float32Array(3 * pixels);
        // sharp raw output is interleaved RGB (HWC); the model wants
        // planar CHW. Normalise per channel as we transpose.
        for (let i = 0; i < pixels; i++) {
            const r = data[i * 3] / 255;
            const g = data[i * 3 + 1] / 255;
            const b = data[i * 3 + 2] / 255;
            out[i] = (r - MEAN[0]) / STD[0];
            out[pixels + i] = (g - MEAN[1]) / STD[1];
            out[2 * pixels + i] = (b - MEAN[2]) / STD[2];
        }
        return out;
    }

    async identify(image: VisionImage): Promise<PestIdentification> {
        const session = await this.getSession();
        const ort = await loadOnnxRuntime();

        const input = await this.preprocess(image);
        const tensor: Tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);

        const inputName = session.inputNames[0];
        const feeds: Record<string, Tensor> = { [inputName]: tensor };
        const results = await session.run(feeds);

        const outputName = session.outputNames[0];
        const output = results[outputName];
        const logits = Array.from(output.data as Float32Array);

        const labels = resolveLabels();
        const result = logitsToIdentification(logits, labels, this.modelVersion ?? 'cropnet-v1');
        logger.info('onnx vision identify', {
            component: 'vision',
            backend: 'onnx',
            identifiedPest: result.identifiedPest,
            confidence: result.confidence,
        });
        return result;
    }
}

/**
 * S3-Compatible Storage Provider
 *
 * Works with AWS S3, Cloudflare R2, MinIO, and any S3-compatible endpoint.
 * Uses @aws-sdk/client-s3 for operations and @aws-sdk/s3-request-presigner for signed URLs.
 */
import crypto from 'crypto';
import { Readable } from 'stream';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/env';
import type {
    StorageProvider,
    WriteResult,
    WriteOptions,
    HeadResult,
    DownloadUrlOptions,
    UploadUrlOptions,
    SignedUploadTarget,
} from './types';
import { contentDisposition } from '@/lib/http/content-disposition';

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB

function getS3Client(): S3Client {
    const config: ConstructorParameters<typeof S3Client>[0] = {
        region: env.S3_REGION || 'us-east-1',
    };

    // Custom endpoint (R2, MinIO, LocalStack, etc.)
    if (env.S3_ENDPOINT) {
        config.endpoint = env.S3_ENDPOINT;
        config.forcePathStyle = true; // Required for non-AWS endpoints
    }

    // Explicit credentials (optional — falls back to IAM role/instance profile)
    if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
        config.credentials = {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        };
    }

    return new S3Client(config);
}

function getBucket(): string {
    const bucket = env.S3_BUCKET;
    if (!bucket) {
        throw new Error('S3_BUCKET environment variable is required when STORAGE_PROVIDER=s3');
    }
    return bucket;
}

export class S3StorageProvider implements StorageProvider {
    readonly name = 's3' as const;
    private client: S3Client;
    private bucket: string;

    constructor() {
        this.client = getS3Client();
        this.bucket = getBucket();
    }

    async write(pathKey: string, source: Readable | Buffer, opts?: WriteOptions): Promise<WriteResult> {
        const maxSize = opts?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
        const hash = crypto.createHash('sha256');
        let body: Buffer;

        if (Buffer.isBuffer(source)) {
            if (source.length > maxSize) {
                throw new Error(`File size exceeds maximum allowed (${maxSize} bytes)`);
            }
            hash.update(source);
            body = source;
        } else {
            // Collect stream into buffer (S3 PutObject needs known-length body for checksums)
            const chunks: Buffer[] = [];
            let sizeBytes = 0;
            for await (const chunk of source) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                hash.update(buf);
                sizeBytes += buf.length;
                if (sizeBytes > maxSize) {
                    throw new Error(`File size exceeds maximum allowed (${maxSize} bytes)`);
                }
                chunks.push(buf);
            }
            body = Buffer.concat(chunks);
        }

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: pathKey,
            Body: body,
            ContentType: opts?.mimeType || 'application/octet-stream',
            ChecksumSHA256: Buffer.from(hash.copy().digest()).toString('base64'),
        }));

        return {
            sha256: hash.digest('hex'),
            sizeBytes: body.length,
        };
    }

    readStream(pathKey: string): Readable {
        // Return a lazy readable that fetches from S3 on first read
        const client = this.client;
        const bucket = this.bucket;

        const passthrough = new Readable({
            read() { /* data pushed from async fetch below */ },
        });

        // Start the S3 fetch asynchronously
        (async () => {
            try {
                const response = await client.send(new GetObjectCommand({
                    Bucket: bucket,
                    Key: pathKey,
                }));
                const s3Stream = response.Body as Readable;
                s3Stream.on('data', (chunk: Buffer) => passthrough.push(chunk));
                s3Stream.on('end', () => passthrough.push(null));
                s3Stream.on('error', (err: Error) => passthrough.destroy(err));
            } catch (err) {
                passthrough.destroy(err as Error);
            }
        })();

        return passthrough;
    }

    async createSignedDownloadUrl(pathKey: string, opts?: DownloadUrlOptions): Promise<string> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: pathKey,
            ...(opts?.downloadFilename && {
                // #1343 — the SAME bug as the eight route handlers, and the one a
                // `Content-Disposition` grep structurally cannot find: the S3
                // parameter is spelled `ResponseContentDisposition`, with no
                // hyphen. Found by the convergence guard rather than by search,
                // which is the argument for the guard over a one-off sweep.
                //
                // It matters because this is what the presigned URL carries in S3
                // redirect mode, so in that mode it is the only disposition the
                // user ever sees — the route's own header is on the 302, not the
                // download.
                ResponseContentDisposition: contentDisposition(opts.downloadFilename),
            }),
        });
        return getSignedUrl(this.client, command, {
            expiresIn: opts?.expiresIn ?? 3600,
        });
    }

    async createSignedUploadUrl(pathKey: string, opts?: UploadUrlOptions): Promise<SignedUploadTarget> {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: pathKey,
            ...(opts?.mimeType && { ContentType: opts.mimeType }),
        });
        const url = await getSignedUrl(this.client, command, {
            expiresIn: opts?.expiresIn ?? 3600,
        });
        return {
            url,
            method: 'PUT',
            expiresIn: opts?.expiresIn ?? 3600,
        };
    }

    async head(pathKey: string): Promise<HeadResult> {
        const response = await this.client.send(new HeadObjectCommand({
            Bucket: this.bucket,
            Key: pathKey,
        }));
        return {
            sizeBytes: response.ContentLength ?? 0,
            mimeType: response.ContentType,
            lastModified: response.LastModified,
        };
    }

    async delete(pathKey: string): Promise<void> {
        // S3 DeleteObject is idempotent — no error if key doesn't exist
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: pathKey,
        }));
    }

    async copy(srcKey: string, destKey: string): Promise<void> {
        await this.client.send(new CopyObjectCommand({
            Bucket: this.bucket,
            Key: destKey,
            CopySource: `${this.bucket}/${srcKey}`,
        }));
    }
}

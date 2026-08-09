/**
 * `<FileDropzone>` rendered tests — Epic 43 prompt 1.
 *
 * Locks the dropzone's behavioural contract:
 *   - drag/drop highlights on dragover and accepts files on drop
 *   - click-to-browse fallback opens the file input
 *   - accept + size validation rejects bad files visibly
 *   - multi-file support: all dropped files appear as queued rows
 *   - autoStart=true triggers `onUpload` immediately on drop
 *   - autoStart=false defers uploads; imperative startAll() runs them
 *   - progress callback wires the percent into the row's status label
 *   - upload error surfaces on the row
 *
 * Approach: stub `onUpload` so we practice progress + completion
 * synchronously via a Promise we resolve from the test. No real XHR.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import {
    FileDropzone,
    type FileDropzoneHandle,
} from '@/components/ui/FileDropzone';

// ─── Helpers ────────────────────────────────────────────────────────

function makeFile(
    name: string,
    bytes = 32,
    type = 'application/pdf',
): File {
    return new File([new Uint8Array(bytes)], name, { type });
}

function dropFiles(target: HTMLElement, files: File[]) {
    const dataTransfer = {
        files,
        types: ['Files'],
        items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
    };
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });
}

// Deferred promise so the test can resolve uploads on demand.
function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('<FileDropzone>', () => {
    it('renders the drop area with the default copy', () => {
        render(<FileDropzone onUpload={async () => undefined} />);
        expect(screen.getByTestId('file-dropzone')).toBeInTheDocument();
        expect(
            screen.getByText(/drag and drop files or click to browse/i),
        ).toBeInTheDocument();
    });

    it('forwards inputId to the hidden <input type=file>', () => {
        render(
            <FileDropzone inputId="my-file-input" onUpload={async () => undefined} />,
        );
        const input = document.getElementById('my-file-input');
        expect(input).not.toBeNull();
        expect(input?.tagName).toBe('INPUT');
    });

    it('highlights on dragover and accepts dropped files', async () => {
        const onUpload = jest.fn(async () => ({ ok: true }));
        render(
            <FileDropzone
                multiple
                accept=".pdf"
                onUpload={onUpload}
            />,
        );
        const zone = screen.getByTestId('file-dropzone');
        expect(zone.getAttribute('data-drag-active')).toBe('false');

        const f1 = makeFile('a.pdf');
        const f2 = makeFile('b.pdf');
        dropFiles(zone, [f1, f2]);

        // Both rows queued.
        await waitFor(() => {
            expect(screen.getByTestId('file-dropzone-list')).toBeInTheDocument();
        });
        expect(screen.getAllByText(/^[ab]\.pdf$/)).toHaveLength(2);

        // autoStart=true (default) triggers onUpload for each file.
        await waitFor(() => {
            expect(onUpload).toHaveBeenCalledTimes(2);
        });
    });

    it('rejects files that exceed maxFileSizeMB with a visible hint', () => {
        render(
            <FileDropzone
                onUpload={async () => undefined}
                maxFileSizeMB={1}
                accept=""
            />,
        );
        const zone = screen.getByTestId('file-dropzone');
        // 2 MB file
        const big = makeFile('big.pdf', 2 * 1024 * 1024);
        dropFiles(zone, [big]);

        const hint = screen.getByTestId('file-dropzone-hint');
        expect(hint.textContent).toMatch(/exceeds 1 MB limit/i);
        expect(screen.queryByTestId('file-dropzone-list')).toBeNull();
    });

    it('rejects files that fail the accept= filter', () => {
        render(
            <FileDropzone
                onUpload={async () => undefined}
                accept=".pdf"
            />,
        );
        const zone = screen.getByTestId('file-dropzone');
        const wrong = makeFile('thing.exe', 32, 'application/x-msdownload');
        dropFiles(zone, [wrong]);
        const hint = screen.getByTestId('file-dropzone-hint');
        expect(hint.textContent).toMatch(/file type not accepted/i);
    });

    it('reports per-file progress via the onProgress callback', async () => {
        const d = deferred<unknown>();
        let progressCb: ((p: number | null) => void) | null = null;
        const onUpload = jest.fn(async (_file, ctx) => {
            progressCb = ctx.onProgress;
            return d.promise;
        });
        render(<FileDropzone onUpload={onUpload} />);
        const zone = screen.getByTestId('file-dropzone');
        dropFiles(zone, [makeFile('a.pdf')]);

        await waitFor(() => {
            expect(progressCb).toBeTruthy();
        });

        // Send a progress signal — the row's status label should
        // reflect the percent.
        await act(async () => {
            progressCb!(42);
        });
        await waitFor(() => {
            expect(screen.getByText('42%')).toBeInTheDocument();
        });

        // Resolve the upload — row should become "Uploaded".
        await act(async () => {
            d.resolve({ id: 'ev_1' });
        });
        await waitFor(() => {
            expect(screen.getByText('Uploaded')).toBeInTheDocument();
        });
    });

    it('autoStart=false defers uploads; ref.startAll() runs them', async () => {
        const onUpload = jest.fn(async () => ({ ok: true }));
        const ref = React.createRef<FileDropzoneHandle>();
        render(
            <FileDropzone
                ref={ref}
                autoStart={false}
                onUpload={onUpload}
            />,
        );
        const zone = screen.getByTestId('file-dropzone');
        dropFiles(zone, [makeFile('a.pdf'), makeFile('b.pdf')]);

        // Files queued, but onUpload not called yet.
        await waitFor(() => {
            expect(screen.getAllByText(/^[ab]\.pdf$/)).toHaveLength(2);
        });
        expect(onUpload).not.toHaveBeenCalled();

        // Driver triggers the start — both uploads run.
        await act(async () => {
            await ref.current!.startAll();
        });
        expect(onUpload).toHaveBeenCalledTimes(2);
    });

    it('renders error status when onUpload rejects', async () => {
        const onUpload = jest.fn(async () => {
            throw new Error('boom');
        });
        render(<FileDropzone onUpload={onUpload} />);
        const zone = screen.getByTestId('file-dropzone');
        dropFiles(zone, [makeFile('a.pdf')]);
        await waitFor(() => {
            expect(screen.getByText('boom')).toBeInTheDocument();
        });
    });

    it('disabled mode blocks drop + click', () => {
        const onUpload = jest.fn();
        render(<FileDropzone onUpload={onUpload} disabled />);
        const zone = screen.getByTestId('file-dropzone');
        expect(zone.getAttribute('aria-disabled')).toBe('true');
        dropFiles(zone, [makeFile('a.pdf')]);
        expect(onUpload).not.toHaveBeenCalled();
    });

    it('multiple=false accepts only the first dropped file', async () => {
        const onUpload = jest.fn(async () => undefined);
        render(<FileDropzone multiple={false} onUpload={onUpload} />);
        const zone = screen.getByTestId('file-dropzone');
        dropFiles(zone, [makeFile('a.pdf'), makeFile('b.pdf')]);
        await waitFor(() => {
            expect(screen.getByText('a.pdf')).toBeInTheDocument();
        });
        expect(screen.queryByText('b.pdf')).toBeNull();
    });

    it('progressbar role exposes the current percentage value', async () => {
        const d = deferred<unknown>();
        let progressCb: ((p: number | null) => void) | null = null;
        const onUpload = jest.fn(async (_file, ctx) => {
            progressCb = ctx.onProgress;
            return d.promise;
        });
        render(<FileDropzone onUpload={onUpload} />);
        const zone = screen.getByTestId('file-dropzone');
        dropFiles(zone, [makeFile('a.pdf')]);
        await waitFor(() => {
            expect(progressCb).toBeTruthy();
        });
        await act(async () => {
            progressCb!(73);
        });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('73');

        await act(async () => {
            d.resolve(null);
        });
    });
});

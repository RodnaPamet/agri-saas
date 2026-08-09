/**
 * TraceabilityPanel — Link form regressions.
 *
 * Mounts the real `<TraceabilityPanel>` (entityType=asset) and asserts:
 *
 *   1. Committing the Link Control form closes THAT form and POSTs the
 *      link. This descends from a regression where the shared
 *      `linkMutation.onSuccess` closed every `showAdd*` flag
 *      unconditionally; the original test proved a second, still-open
 *      form survived the commit. An asset now has exactly ONE link
 *      section (its Risks arm went with the risk register), so the
 *      two-forms-at-once shape is no longer expressible — what remains
 *      testable, and what the regression was really about, is that
 *      onSuccess closes the form it committed and fires the right POST.
 *
 *   2. Control / asset options in the Combobox are rendered via
 *      `optionDescription` so the cmdk row uses the wrapping
 *      (description-mode) layout — i.e. no `truncate` class on the
 *      label span — keeping long names readable.
 */
/** @jest-environment jsdom */

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

import TraceabilityPanel from "@/components/TraceabilityPanel";

// ─── jsdom — pin to desktop so Combobox uses Popover, not Drawer ────
// `tests/rendered/setup.ts` stubs matchMedia to always return
// `matches: false`, which makes `useMediaQuery` resolve to `mobile`
// and switches Combobox into Vaul Drawer mode — the dropdown
// listbox under test doesn't render in that branch. Force desktop
// by reporting a match on the desktop min-width query.
const originalMatchMedia = window.matchMedia;
beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: (query: string) => ({
            matches: query.includes("1024"),
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        }),
    });
});
afterAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: originalMatchMedia,
    });
});

// ─── fetch mock ─────────────────────────────────────────────────────

const fetchMock = jest.fn();
beforeEach(() => {
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetch }).fetch =
        fetchMock as unknown as typeof fetch;
});

const EMPTY_TRACE = { controls: [], assets: [] };

const AVAILABLE_CONTROLS = [
    {
        id: "ctrl-1",
        code: "AC-2",
        // Deliberately long — pre-fix this triggered `truncate` on the
        // option label span. With `optionDescription` wired up the row
        // switches to flex-col + whitespace-normal and the name wraps.
        name: "Information Security Policy Management and Acceptable Use Procedure for Enterprise SaaS Applications",
        status: "APPROVED",
    },
    { id: "ctrl-2", code: "AC-3", name: "Account management", status: "DESIGN" },
];

function ok(json: unknown) {
    return {
        ok: true,
        status: 200,
        json: async () => json,
    } as unknown as Response;
}

function setupRoutes(): void {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith("/assets/asset-1/traceability")) return Promise.resolve(ok(EMPTY_TRACE));
        if (url.endsWith("/controls")) return Promise.resolve(ok(AVAILABLE_CONTROLS));
        if (init?.method === "POST" && url.endsWith("/assets/asset-1/controls")) {
            return Promise.resolve(ok({ id: "link-1" }));
        }
        return Promise.resolve(ok({}));
    });
}

function mountPanel() {
    setupRoutes();
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={client}>
            <TooltipProvider delayDuration={0}>
                <TraceabilityPanel
                    apiBase="/api/t/acme/"
                    entityType="asset"
                    entityId="asset-1"
                    canWrite
                    tenantHref={(p) => p}
                    tenantSlug="acme"
                />
            </TooltipProvider>
        </QueryClientProvider>,
    );
}

describe("TraceabilityPanel — link form regressions", () => {
    it("committing the Link form closes it and POSTs the link", async () => {
        const user = userEvent.setup();
        mountPanel();

        await waitFor(() => {
            expect(screen.getByText("No controls linked")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "Link Control" }));

        // Wait for the available-controls fetch to populate so the
        // combobox has options to render.
        await waitFor(() => {
            const calls = fetchMock.mock.calls.map(([u]) =>
                typeof u === "string" ? u : (u as URL).toString(),
            );
            expect(calls.some((u) => u.endsWith("/controls"))).toBe(true);
        });

        // Open the Control popover and pick ctrl-2.
        const controlTrigger = document.getElementById("control-select") as HTMLButtonElement;
        await user.click(controlTrigger);
        // Label format is `${code} — ${name}` since the fix.
        const option = await screen.findByText("AC-3 — Account management");
        await user.click(option);

        // Confirm the link.
        const confirm = document.getElementById("confirm-control-link") as HTMLButtonElement;
        await waitFor(() => {
            expect(confirm).not.toBeDisabled();
        });
        await act(async () => {
            await user.click(confirm);
        });

        // After success the committed form closes...
        await waitFor(() => {
            expect(document.getElementById("control-select")).not.toBeInTheDocument();
        });
        // ...and the link actually went to the asset↔control endpoint.
        const posts = fetchMock.mock.calls.filter(
            ([, init]) => (init as RequestInit | undefined)?.method === "POST",
        );
        expect(posts).toHaveLength(1);
        expect(posts[0]?.[0]).toBe("/api/t/acme/assets/asset-1/controls");
        expect(
            JSON.parse((posts[0]?.[1] as RequestInit).body as string),
        ).toMatchObject({ controlId: "ctrl-2" });
    });

    it("control combobox options render with optionDescription (no truncate on label)", async () => {
        const user = userEvent.setup();
        mountPanel();

        await waitFor(() => {
            expect(screen.getByText("No controls linked")).toBeInTheDocument();
        });

        await user.click(screen.getByRole("button", { name: "Link Control" }));

        // Wait for the available-controls fetch to populate.
        await waitFor(() => {
            const calls = fetchMock.mock.calls.map(([u]) =>
                typeof u === "string" ? u : (u as URL).toString(),
            );
            expect(calls.some((u) => u.endsWith("/controls"))).toBe(true);
        });

        const controlTrigger = document.getElementById("control-select") as HTMLButtonElement;
        await user.click(controlTrigger);

        // The long control name renders; locate the label span — it must
        // NOT carry the `truncate` class (the description-mode branch in
        // Combobox suppresses it), and the description ("Status: …")
        // must appear as a separate node.
        const labelNode = await screen.findByText(
            "AC-2 — Information Security Policy Management and Acceptable Use Procedure for Enterprise SaaS Applications",
        );
        expect(labelNode.className).not.toMatch(/\btruncate\b/);
        expect(screen.getByText("Status: APPROVED")).toBeInTheDocument();
    });
});

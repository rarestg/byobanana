// @vitest-environment jsdom
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";

import { fireEvent, render, screen, userEvent, waitFor, within } from "../../test-utils";
import { clearCompressionCache, compressImage } from "../core/compress";
import { buildIconSuiteBundle, type IconSuiteBundle } from "../core/exportBundle";
import { type CircularIcon, exportCircularIcon } from "../core/image";
import { loadRecipes, renderRecipe } from "../core/recipes";
import { COLOR_PALETTES } from "../core/palettes";
import {
  type ArmRecord,
  type CandidateRecord,
  type CandidateStatus,
  type ExportInput,
  type GeneratedImage,
  type ImageMeta,
  type SessionManifest,
  type SessionRepository,
  sha256Hex,
} from "../core/session";
import { InspectorSlot } from "./InspectorSlot";
import { computeZoomBackgroundSize } from "./zoomScale";

// The worker/wasm pixel path can't run in jsdom: mock ONLY compressImage; the matrix, the
// per-blobId cache, and the label plumbing stay real (that's what these tests exercise).
vi.mock("../core/compress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/compress")>()),
  compressImage: vi.fn(),
}));
const compressImageMock = vi.mocked(compressImage);

// The Canvas render (exportCircularIcon) and the suite assembly (worker + canvas) can't run
// in jsdom either: mock ONLY those two; every other exportBundle/image helper stays real.
vi.mock("../core/image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/image")>()),
  exportCircularIcon: vi.fn(),
}));
const exportCircularIconMock = vi.mocked(exportCircularIcon);
vi.mock("../core/exportBundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/exportBundle")>()),
  buildIconSuiteBundle: vi.fn(),
}));
const buildIconSuiteBundleMock = vi.mocked(buildIconSuiteBundle);

// jsdom lacks object-URL APIs; the succeeded preview creates one via useBlobUrl.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

const iconRecipe = loadRecipes().find((entry) => entry.id === "geometric-isometric-icon")!;
const imageRecipe = loadRecipes().find((entry) => entry.id === "hard-edge-geometric-screenprint")!;
const palette = COLOR_PALETTES[0];

function candidate(
  id: string,
  variant: number,
  status: CandidateStatus,
  extra: Partial<CandidateRecord> = {},
): CandidateRecord {
  return {
    id,
    armId: extra.armId ?? "arm-1",
    variant,
    status,
    queuedAt: "2026-01-01T00:00:00.000Z",
    images: [],
    ...extra,
  };
}

const succeededImage = {
  id: "im",
  blobId: "blob-1",
  mimeType: "image/svg+xml",
  bytes: 10,
  width: 512,
  height: 512,
  sha256: "s",
};

function arm(recipe = iconRecipe, candidates: CandidateRecord[]): ArmRecord {
  return {
    id: "arm-1",
    recipe,
    recipeSha256: "sha",
    renderedPrompt: renderRecipe(recipe, "A subject", palette, "#FAFAFA"),
    promptSha256: "psha",
    candidates,
  };
}

function manifest(
  candidates: CandidateRecord[],
  recipe = iconRecipe,
  status: SessionManifest["status"] = "partial",
): SessionManifest {
  return {
    format: "nano-banana-web/session",
    schemaVersion: 1,
    id: "session-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status,
    subject: "A subject",
    settings: {
      modelId: "gemini-3.1-flash-image",
      size: "512",
      googleSearch: false,
      variantsPerRecipe: 2,
      callCount: 2,
    },
    estimate: { status: "estimated", usd: 0.05, excludesGrounding: false },
    confirmation: { required: false, acknowledged: false, reasons: [] },
    references: [],
    exports: [],
    arms: [arm(recipe, candidates)],
  };
}

// A repo stub: the inspector calls getBlob (for the preview) and selectPrimary. selectPrimary
// flips selectedCandidateId on the SAME base manifest (preserving its candidates), mirroring
// the real repo mutating its stored manifest.
function stubRepo(base: SessionManifest): SessionRepository {
  return {
    getBlob: async () => new Blob(["x"], { type: "image/svg+xml" }),
    selectPrimary: async (_sid: string, cid: string | null) => ({
      ...base,
      selectedCandidateId: cid ?? undefined,
    }),
  } as unknown as SessionRepository;
}

// A controlled harness so onManifestChange actually re-renders the inspector (Primary flow).
function Harness({
  repo,
  initial,
  focusedCandidateId,
}: {
  repo: SessionRepository;
  initial: SessionManifest;
  focusedCandidateId: string;
}) {
  const [current, setCurrent] = useState(initial);
  return (
    <InspectorSlot
      repo={repo}
      manifest={current}
      focusedCandidateId={focusedCandidateId}
      onManifestChange={setCurrent}
      onEditSetup={() => {}}
    />
  );
}

// Render the inspector against a base manifest, wiring the repo stub to the same base.
function renderInspector(base: SessionManifest, focusedCandidateId: string) {
  return render(<Harness repo={stubRepo(base)} initial={base} focusedCandidateId={focusedCandidateId} />);
}

describe("InspectorSlot", () => {
  it("shows the empty hint when nothing is focused", () => {
    renderInspector(manifest([candidate("c1", 1, "succeeded")]), "");
    expect(screen.getByText("Select a candidate to inspect it.")).toBeInTheDocument();
  });

  it("renders the focused candidate's identity path and Status/Cost facts", async () => {
    const c = candidate("c1", 1, "succeeded", {
      images: [succeededImage],
      cost: { status: "calculated", usd: 0.0123, excludesGrounding: false },
      modelVersion: "gemini-3.1-flash-image-preview",
    });
    renderInspector(manifest([c]), "c1");
    await screen.findByAltText(/Generated /); // let the object URL settle
    const path = screen.getByLabelText("Candidate identity");
    expect(within(path).getByText(iconRecipe.name)).toBeInTheDocument();
    expect(within(path).getByText("A subject")).toBeInTheDocument();
    expect(within(path).getByText("Variant 1 of 1")).toBeInTheDocument();
    // Facts: Status + Cost (compact cents, P8) + Model + Size incl. file size (P9).
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("1.2¢")).toBeInTheDocument();
    expect(screen.getByText("gemini-3.1-flash-image-preview")).toBeInTheDocument();
    expect(screen.getByText("512×512 · 0.0 KB")).toBeInTheDocument();
  });

  it("Set Primary on a succeeded candidate updates state and swaps to Clear Primary", async () => {
    const user = userEvent.setup();
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    await screen.findByAltText(/Generated /); // let the object URL settle

    await user.click(screen.getByRole("button", { name: "Set as Primary" }));
    // The returned manifest carries selectedCandidateId -> Clear Primary + a Primary badge.
    await screen.findByRole("button", { name: "Clear Primary" });
    expect(screen.getByText("This is the Primary candidate for the run.")).toBeInTheDocument();

    // Clear Primary reverses it.
    await user.click(screen.getByRole("button", { name: "Clear Primary" }));
    await screen.findByRole("button", { name: "Set as Primary" });
  });

  it("does not offer Set Primary for a dead run's non-succeeded candidate", () => {
    const c = candidate("c1", 1, "failed", { error: "The provider blocked this request." });
    // Whole run is dead (no succeeded candidate, terminal status) -> Primary section is
    // replaced by the recovery affordance, so Set as Primary is not offered at all.
    renderInspector(manifest([c], iconRecipe, "failed"), "c1");
    expect(screen.queryByRole("button", { name: "Set as Primary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit and regenerate" })).toBeInTheDocument();
  });

  it("disables Set Primary when the focus is on a non-succeeded candidate", () => {
    const succeeded = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    const failed = candidate("c2", 2, "failed", { error: "Blocked." });
    renderInspector(manifest([succeeded, failed]), "c2");
    // The run has a succeeded candidate (not terminal-recovery), so Primary shows — but the
    // focused failed candidate can't be Primary: the button is disabled.
    expect(screen.getByRole("button", { name: "Set as Primary" })).toBeDisabled();
  });

  it("shows Small-size previews for the icon family and hides them for the image family", async () => {
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    const { unmount } = renderInspector(manifest([c], iconRecipe), "c1");
    // The disclosure appears once the object URL resolves (icon family only).
    await screen.findByText("Small-size previews");
    unmount();

    renderInspector(manifest([c], imageRecipe), "c1");
    await screen.findByAltText(/Generated /);
    expect(screen.queryByText("Small-size previews")).not.toBeInTheDocument();
  });

  it("renders the small-size previews at 80/96/112px on light and dark cells", async () => {
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c], iconRecipe), "c1");
    await screen.findByText("Small-size previews");
    const grid = screen.getByLabelText("Small-size previews");
    // 3 sizes × light+dark = 6 <img>, each sized to its px.
    const imgs = within(grid).getAllByRole("presentation", { hidden: true }) as HTMLImageElement[];
    expect(imgs).toHaveLength(6);
    expect(imgs.map((img) => img.getAttribute("width"))).toEqual(["80", "80", "96", "96", "112", "112"]);
    expect(within(grid).getByText("80px")).toBeInTheDocument();
    expect(within(grid).getByText("96px")).toBeInTheDocument();
    expect(within(grid).getByText("112px")).toBeInTheDocument();
  });

  it("shows the stored friendly failure message verbatim for a failed candidate", () => {
    // The queue stores ALREADY-friendly copy; the inspector must show it verbatim, not
    // re-normalize it back to the generic fallback.
    const c = candidate("c1", 1, "failed", {
      error: "The provider rejected the credentials. Check your API key, then edit the setup and regenerate.",
    });
    renderInspector(manifest([c]), "c1");
    expect(screen.getByText("Failure detail")).toBeInTheDocument();
    expect(screen.getByText(/provider rejected the credentials/i)).toBeInTheDocument();
    // Not collapsed to the generic fallback.
    expect(screen.queryByText(/This candidate could not be generated/i)).not.toBeInTheDocument();
  });

  it("shows the interruption detail for an interrupted candidate", () => {
    const c = candidate("c1", 1, "interrupted", {
      error: "Generation stopped before the request was submitted.",
      cancellation: { requestedAt: "2026-01-01T00:00:00.000Z", billing: "not-submitted" },
    });
    renderInspector(manifest([c], iconRecipe, "interrupted"), "c1");
    expect(screen.getByText("Run interrupted")).toBeInTheDocument();
    expect(screen.getByText(/stopped before the request was submitted/i)).toBeInTheDocument();
  });

  it("never renders an unavailable cost as $0", () => {
    const c = candidate("c1", 1, "interrupted", {
      cost: { status: "unavailable", excludesGrounding: false },
      cancellation: { requestedAt: "2026-01-01T00:00:00.000Z", billing: "unknown-may-be-charged" },
    });
    renderInspector(manifest([c]), "c1");
    expect(screen.getByText("Unknown; may have been charged")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.0000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
  });

  it("shows a genuine 0.0¢ for a succeeded candidate with zero calculated cost", async () => {
    const c = candidate("c1", 1, "succeeded", {
      images: [succeededImage],
      cost: { status: "calculated", usd: 0, excludesGrounding: false },
    });
    renderInspector(manifest([c]), "c1");
    await screen.findByAltText(/Generated /); // let the object URL settle
    expect(screen.getByText("0.0¢")).toBeInTheDocument();
  });

  it("renders an upper-bound cost as compact cents with the 'Up to' prefix", async () => {
    const c = candidate("c1", 1, "succeeded", {
      images: [succeededImage],
      cost: { status: "upper-bound", usd: 0.0495, excludesGrounding: false },
    });
    renderInspector(manifest([c]), "c1");
    await screen.findByAltText(/Generated /);
    expect(screen.getByText("Up to 5.0¢")).toBeInTheDocument();
  });

  it("treats a malformed unavailable cost carrying usd:0 as Unavailable, never a number", () => {
    const c = candidate("c1", 1, "failed", {
      error: "boom",
      cost: { status: "unavailable", usd: 0, excludesGrounding: false } as never,
    });
    renderInspector(manifest([c]), "c1");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/0\.0¢/)).not.toBeInTheDocument();
  });
});

describe("InspectorSlot — hover zoom (P8, P9 viewport-scaled panel, P10 natural-resolution magnification)", () => {
  // jsdom has no layout: give the preview image a real box + natural size so the
  // contain-rect math can run. jsdom's window is 1024×768, so the viewport-scaled panel
  // resolves to min(420, round(1024*0.3)=307, 768-16=752) = 307px.
  function mockRects(box = { left: 900, top: 100, right: 1200, bottom: 400 }) {
    return vi
      .spyOn(HTMLImageElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        ...box,
        width: box.right - box.left,
        height: box.bottom - box.top,
        x: box.left,
        y: box.top,
        toJSON: () => ({}),
      } as DOMRect);
  }

  it("shows the magnifier while the pointer is over the image and hides it on leave", async () => {
    const rectSpy = mockRects();
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    const img = await screen.findByAltText(/Generated /);

    // jsdom lacks a PointerEvent constructor and its generic Event fallback drops clientX/Y,
    // so dispatch a real MouseEvent with the pointermove type (React listens by type).
    fireEvent(img, new MouseEvent("pointermove", { clientX: 1050, clientY: 250, bubbles: true }));
    await waitFor(() => expect(screen.getByTestId("zoom-panel")).toBeInTheDocument());
    const panel = screen.getByTestId("zoom-panel");
    // Panel floats LEFT of the image (never overlapping it), sized to the viewport (307px here).
    expect(panel.style.width).toBe("307px");
    expect(panel.style.left).toBe("573px"); // 900 - 307 - 20 gap
    expect(panel.style.backgroundImage).toContain("blob:mock");
    // Magnification is anchored to the NATURAL 512×512 image (P10) — panel size (307), not the
    // 300px displayed size, so the wiring is checked against the shared scale function itself.
    const { bgW, bgH } = computeZoomBackgroundSize(512, 512, 307);
    expect(panel.style.backgroundSize).toBe(`${bgW}px ${bgH}px`);

    fireEvent.pointerLeave(img);
    expect(screen.queryByTestId("zoom-panel")).not.toBeInTheDocument();
    rectSpy.mockRestore();
  });

  it("magnifies identically regardless of the DISPLAYED preview size (the P10 bug fix)", async () => {
    // Same natural 512×512 image, but rendered in a much LARGER displayed box (700×700, as a
    // narrow-viewport stacked layout would) instead of the 300×300 box above (a wide-monitor
    // narrow sidebar). The old dispW*ZOOM_SCALE formula would have magnified this far MORE
    // aggressively; the fix must produce the identical backgroundSize either way.
    const rectSpy = mockRects({ left: 900, top: 100, right: 1600, bottom: 800 });
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    const img = await screen.findByAltText(/Generated /);

    fireEvent(img, new MouseEvent("pointermove", { clientX: 1250, clientY: 450, bubbles: true }));
    await waitFor(() => expect(screen.getByTestId("zoom-panel")).toBeInTheDocument());
    const panel = screen.getByTestId("zoom-panel");
    const { bgW, bgH } = computeZoomBackgroundSize(512, 512, 307);
    expect(panel.style.backgroundSize).toBe(`${bgW}px ${bgH}px`); // identical to the 300×300 case

    fireEvent.pointerLeave(img);
    rectSpy.mockRestore();
  });

  it("falls back to the right side when the left gap cannot host a useful panel", async () => {
    // Image hugs the left edge: leftSpace = 30-28 = 2px < 200 min; right side has room.
    const rectSpy = mockRects({ left: 30, top: 100, right: 330, bottom: 400 });
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    const img = await screen.findByAltText(/Generated /);

    fireEvent(img, new MouseEvent("pointermove", { clientX: 180, clientY: 250, bubbles: true }));
    await waitFor(() => expect(screen.getByTestId("zoom-panel")).toBeInTheDocument());
    const panel = screen.getByTestId("zoom-panel");
    expect(panel.style.width).toBe("307px");
    expect(panel.style.left).toBe("350px"); // image right (330) + 20 gap

    fireEvent.pointerLeave(img);
    rectSpy.mockRestore();
  });

  it("hides entirely when neither side fits the minimum panel", async () => {
    // Center the image in a viewport whose side gaps are both < 200px.
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 640, configurable: true });
    const rectSpy = mockRects({ left: 170, top: 100, right: 470, bottom: 400 });
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    const img = await screen.findByAltText(/Generated /);

    fireEvent(img, new MouseEvent("pointermove", { clientX: 320, clientY: 250, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("zoom-panel")).not.toBeInTheDocument();

    Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
    rectSpy.mockRestore();
  });

  it("does not show the magnifier for pointer positions outside the displayed image", async () => {
    const rectSpy = mockRects();
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c]), "c1");
    const img = await screen.findByAltText(/Generated /);

    // Outside the box entirely (the letterbox guard also relies on this path).
    fireEvent(img, new MouseEvent("pointermove", { clientX: 10, clientY: 10, bubbles: true }));
    // Give the rAF a beat; the panel must never appear.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("zoom-panel")).not.toBeInTheDocument();
    rectSpy.mockRestore();
  });
});

describe("InspectorSlot — circular icon exports (split button + size menu)", () => {
  let pngBlob: Blob;
  let png1024: ImageMeta;
  let png512: ImageMeta;
  beforeAll(async () => {
    pngBlob = new Blob([new Uint8Array(1000)], { type: "image/png" });
    const sha256 = await sha256Hex(pngBlob);
    png1024 = { id: "im-1024", blobId: "blob-1024", mimeType: "image/png", bytes: 1000, width: 1024, height: 1024, sha256 };
    png512 = { ...png1024, id: "im-512", blobId: "blob-512", width: 512, height: 512 };
  });

  beforeEach(() => {
    clearCompressionCache();
    exportCircularIconMock.mockReset();
    buildIconSuiteBundleMock.mockReset();
  });

  function iconHarness(image: ImageMeta) {
    const base = manifest([candidate("c1", 1, "succeeded", { images: [image] })], iconRecipe);
    const recordExport = vi.fn(async (_sessionId: string, _input: ExportInput) => base);
    const repo = {
      getBlob: async () => pngBlob,
      recordExport,
      selectPrimary: async () => base,
    } as unknown as SessionRepository;
    const utils = render(<Harness repo={repo} initial={base} focusedCandidateId="c1" />);
    return { base, recordExport, ...utils };
  }

  it("renders the split control and the size menu for a square icon candidate", async () => {
    const user = userEvent.setup();
    iconHarness(png1024);
    await screen.findByAltText(/Generated /);

    expect(screen.getByRole("button", { name: "Download circular icon · 512px" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    expect(await screen.findByRole("menuitem", { name: "Full resolution · 1024px" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "256px" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Complete suite (ZIP)" })).toBeEnabled();
  });

  it("hides the full-resolution item when the source is exactly the primary size", async () => {
    const user = userEvent.setup();
    iconHarness(png512);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    await screen.findByRole("menuitem", { name: "256px" });
    expect(screen.queryByRole("menuitem", { name: /Full resolution/ })).not.toBeInTheDocument();
  });

  it("disables the split control (and keeps raw available) for a non-square icon source", async () => {
    const nonSquare: ImageMeta = { ...png1024, id: "im-ns", blobId: "blob-ns", height: 640 };
    iconHarness(nonSquare);
    await screen.findByAltText(/Generated /);

    expect(screen.getByRole("button", { name: "Download circular icon · 512px" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "More circular icon sizes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Raw / })).toBeEnabled();
    expect(
      screen.getByText(/Project icons require a square generated image/),
    ).toBeInTheDocument();
  });

  it("downloads the primary 512 circle and records raw + production", async () => {
    const user = userEvent.setup();
    const production: CircularIcon = {
      blob: new Blob([new Uint8Array(50)], { type: "image/png" }),
      mimeType: "image/png",
      width: 512,
      height: 512,
      sha256: "p".repeat(64),
      encoding: "quantized",
    };
    exportCircularIconMock.mockResolvedValue(production);
    const { recordExport } = iconHarness(png1024);
    await screen.findByAltText(/Generated /);
    const urlCalls = vi.mocked(URL.createObjectURL).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Download circular icon · 512px" }));
    await waitFor(() => expect(recordExport).toHaveBeenCalledTimes(1));
    expect(exportCircularIconMock).toHaveBeenCalledWith(pngBlob, 512);
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBeGreaterThan(urlCalls);
    expect(recordExport.mock.calls[0][1]).toMatchObject({ candidateId: "c1", production });
  });

  it("menu action: full resolution renders at the source size", async () => {
    const user = userEvent.setup();
    exportCircularIconMock.mockResolvedValue({
      blob: new Blob([new Uint8Array(50)], { type: "image/png" }),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      sha256: "p".repeat(64),
      encoding: "quantized",
    });
    const { recordExport } = iconHarness(png1024);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Full resolution · 1024px" }));
    await waitFor(() => expect(recordExport).toHaveBeenCalledTimes(1));
    expect(exportCircularIconMock).toHaveBeenCalledWith(pngBlob, 1024);
  });

  it("menu action: the complete suite downloads its ZIP and records ONE export", async () => {
    const user = userEvent.setup();
    const raw: GeneratedImage = { blob: pngBlob, mimeType: "image/png", width: 1024, height: 1024, sha256: png1024.sha256 };
    const suite = {
      filename: "byobanana-session-1-geometric-isometric-icon-variant-1-icon-suite.zip",
      zip: new Uint8Array([80, 75, 3, 4]) as Uint8Array<ArrayBuffer>,
      manifestText: "",
      assets: [],
      notes: [],
      recordInput: { candidateId: "c1", raw, production: { ...raw, width: 512, height: 512 } },
    } satisfies IconSuiteBundle;
    buildIconSuiteBundleMock.mockResolvedValue(suite);
    const { recordExport } = iconHarness(png1024);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Complete suite (ZIP)" }));
    await waitFor(() => expect(recordExport).toHaveBeenCalledTimes(1));
    expect(buildIconSuiteBundleMock).toHaveBeenCalledTimes(1);
    expect(recordExport.mock.calls[0][1]).toBe(suite.recordInput);
  });

  it("returns keyboard focus to the caret after a menu export settles", async () => {
    // The caret target must stay focusable during `exporting`: Menu returns focus to it on
    // close, and a disabled target would drop keyboard focus to <body>.
    const user = userEvent.setup();
    exportCircularIconMock.mockResolvedValue({
      blob: new Blob([new Uint8Array(50)], { type: "image/png" }),
      mimeType: "image/png",
      width: 256,
      height: 256,
      sha256: "p".repeat(64),
      encoding: "quantized",
    });
    const { recordExport } = iconHarness(png1024);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    await user.click(await screen.findByRole("menuitem", { name: "256px" }));
    await waitFor(() => expect(recordExport).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "More circular icon sizes" })).toHaveFocus(),
    );
  });

  it("surfaces a suite failure through the shared error notification", async () => {
    const user = userEvent.setup();
    const notify = vi.spyOn(notifications, "show");
    buildIconSuiteBundleMock.mockRejectedValue(new Error("The icon suite exceeds 256 MiB (circle-full)."));
    const { recordExport } = iconHarness(png1024);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "More circular icon sizes" }));
    await user.click(await screen.findByRole("menuitem", { name: "Complete suite (ZIP)" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", title: "Could not build the icon suite" }),
      ),
    );
    expect(recordExport).not.toHaveBeenCalled();
    notify.mockRestore();
  });
});

describe("InspectorSlot — optimized download (P13)", () => {
  // A real PNG-typed blob whose size + sha match the manifest metadata, so rawImage()'s
  // stored-bytes verification passes when the compressed path re-reads it.
  let pngBlob: Blob;
  let pngImage: ImageMeta;
  beforeAll(async () => {
    pngBlob = new Blob([new Uint8Array(1000)], { type: "image/png" });
    pngImage = {
      id: "im-png",
      blobId: "blob-png",
      mimeType: "image/png",
      bytes: 1000,
      width: 512,
      height: 512,
      sha256: await sha256Hex(pngBlob),
    };
  });

  beforeEach(() => {
    clearCompressionCache();
    compressImageMock.mockReset();
  });

  function compressed(size: number, mimeType = "image/jpeg"): GeneratedImage {
    return {
      blob: new Blob([new Uint8Array(size)], { type: mimeType }),
      mimeType,
      width: 512,
      height: 512,
      sha256: "c".repeat(64),
    };
  }

  // Repo stub for the download path: getBlob returns the REAL png blob (verification must
  // pass); recordExport just echoes the base manifest.
  function repo(base: SessionManifest): SessionRepository {
    return {
      getBlob: async () => pngBlob,
      recordExport: async () => base,
      selectPrimary: async () => base,
    } as unknown as SessionRepository;
  }

  function renderPng(recipe = imageRecipe, images: ImageMeta[] = [pngImage]) {
    const candidates = images.map((image, index) =>
      candidate(`c${index + 1}`, index + 1, "succeeded", { images: [image] }),
    );
    const base = manifest(candidates, recipe);
    const utils = render(
      <Harness repo={repo(base)} initial={base} focusedCandidateId="c1" />,
    );
    return { base, ...utils };
  }

  it("renders the split button: raw size + the planned Smaller JPEG label and lossy hint", async () => {
    renderPng(imageRecipe);
    await screen.findByAltText(/Generated /);
    expect(screen.getByRole("button", { name: "Raw · 1.0 KB" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Smaller JPEG" })).toBeEnabled();
    expect(screen.getByText(/lossy re-encode \(quality 80\)/)).toBeInTheDocument();
  });

  it("offers Optimized PNG (lossless hint) for an icon-family PNG", async () => {
    renderPng(iconRecipe);
    await screen.findByAltText(/Generated /);
    expect(screen.getByRole("button", { name: "Optimized PNG" })).toBeEnabled();
    expect(screen.getByText("The optimized PNG is lossless.")).toBeInTheDocument();
  });

  it("offers no compressed button for a mime outside the matrix (svg)", async () => {
    const c = candidate("c1", 1, "succeeded", { images: [succeededImage] });
    renderInspector(manifest([c], imageRecipe), "c1");
    await screen.findByAltText(/Generated /);
    expect(screen.getByRole("button", { name: "Raw · 0.0 KB" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Smaller JPEG|Optimized PNG/ })).not.toBeInTheDocument();
  });

  it("backfills the real size into the label after a successful compression + download", async () => {
    const user = userEvent.setup();
    compressImageMock.mockResolvedValue(compressed(300));
    renderPng(imageRecipe);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    await screen.findByRole("button", { name: "Small · 0.3 KB" });
    expect(compressImageMock).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalled(); // the download was triggered
  });

  it("keys the hint on the RESULT mime when the alpha guard flips a planned JPEG to PNG", async () => {
    const user = userEvent.setup();
    compressImageMock.mockResolvedValue(compressed(300, "image/png"));
    renderPng(imageRecipe);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    await screen.findByRole("button", { name: "Small · 0.3 KB" });
    expect(screen.getByText("The optimized PNG is lossless.")).toBeInTheDocument();
  });

  it("disables the button as 'No smaller than raw' and downloads nothing when compression loses", async () => {
    const user = userEvent.setup();
    const notify = vi.spyOn(notifications, "show");
    compressImageMock.mockResolvedValue(compressed(5000));
    renderPng(imageRecipe);
    await screen.findByAltText(/Generated /);
    // Snapshot AFTER the preview settles: its own object URL must not count as a download.
    const urlCalls = vi.mocked(URL.createObjectURL).mock.calls.length;

    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    const button = await screen.findByRole("button", { name: "No smaller than raw" });
    expect(button).toBeDisabled();
    expect(vi.mocked(URL.createObjectURL).mock.calls.length).toBe(urlCalls); // no download
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "No smaller than raw" }));
    notify.mockRestore();
  });

  it("surfaces a failure quietly, leaves raw usable, and retries on the next click (evicted cache)", async () => {
    const user = userEvent.setup();
    const notify = vi.spyOn(notifications, "show");
    compressImageMock
      .mockRejectedValueOnce(new Error("worker crashed"))
      .mockResolvedValueOnce(compressed(300));
    renderPng(imageRecipe);
    await screen.findByAltText(/Generated /);

    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ color: "red", title: "Could not download the compressed image" }),
      ),
    );
    // Raw is untouched and the compressed button is clickable again (rejected entry evicted).
    expect(screen.getByRole("button", { name: "Raw · 1.0 KB" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    await screen.findByRole("button", { name: "Small · 0.3 KB" });
    expect(compressImageMock).toHaveBeenCalledTimes(2);
    notify.mockRestore();
  });

  it("never shows a stale result on a newly focused candidate (per-blobId guard)", async () => {
    const user = userEvent.setup();
    const otherImage: ImageMeta = { ...pngImage, id: "im-png-2", blobId: "blob-png-2" };
    let resolveJob!: (value: GeneratedImage) => void;
    compressImageMock.mockImplementation(
      () => new Promise<GeneratedImage>((resolve) => (resolveJob = resolve)),
    );

    const candidates = [
      candidate("c1", 1, "succeeded", { images: [pngImage] }),
      candidate("c2", 2, "succeeded", { images: [otherImage] }),
    ];
    const base = manifest(candidates, imageRecipe);
    const { rerender } = render(
      <Harness repo={repo(base)} initial={base} focusedCandidateId="c1" />,
    );
    await screen.findByAltText(/Generated /);

    // Start a slow compression for c1, then refocus to c2 BEFORE it resolves. The click's
    // async chain (getBlob + sha verification) must actually REACH compressImage before
    // resolveJob exists — wait for the call, not just the click.
    await user.click(screen.getByRole("button", { name: "Smaller JPEG" }));
    await waitFor(() => expect(compressImageMock).toHaveBeenCalledTimes(1));
    rerender(<Harness repo={repo(base)} initial={base} focusedCandidateId="c2" />);
    resolveJob(compressed(300));

    // c2's button never inherits c1's backfilled size.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Smaller JPEG" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /· 0\.3 KB/ })).not.toBeInTheDocument();

    // Refocusing c1 shows ITS settled result straight from the cache.
    rerender(<Harness repo={repo(base)} initial={base} focusedCandidateId="c1" />);
    await screen.findByRole("button", { name: "Small · 0.3 KB" });
  });
});

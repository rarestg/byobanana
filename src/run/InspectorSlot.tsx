// Candidate inspector — the sticky detail panel beside the contact sheet (nano-banana-2
// web/app.js renderInspector). Renders the FOCUSED candidate: identity path, a large
// preview (image / terminal placeholder / queued-running), icon "Small-size previews",
// Status+Cost facts, a failure Alert, and Primary selection. Export (per-candidate ZIP /
// export count) is P5 — a marked placeholder only. Full edit-and-regenerate is P6 — the
// terminal-recovery button only signals the P3 "Edit setup" path.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Anchor, Badge, Button, DataList, Group, Image, Menu, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CaretDown } from "@phosphor-icons/react";

import { formatApproxCost } from "../core/formatCost";
import {
  buildExportBundle,
  buildIconSuiteBundle,
  bundleExportInputs,
  extensionForMime,
  singleDownloadName,
  triggerDownload,
} from "../core/exportBundle";
import {
  cachedCompression,
  compressedFor,
  compressImage,
  compressionHint,
  compressionLabel,
  compressionPlan,
} from "../core/compress";
import { exportCircularIcon, ICON_SIZE } from "../core/image";
import { recipeFamily } from "../core/recipes";
import { computeZoomBackgroundSize } from "./zoomScale";
import {
  type CandidateRecord,
  type ExportInput,
  type GeneratedImage,
  type ImageMeta,
  type SessionManifest,
  type SessionRepository,
  sha256Hex,
} from "../core/session";
import {
  candidateFailureMessage,
  candidateMessage,
  formatBytes,
  formatSize,
  modelShortLabel,
  statusLabel,
  terminalCandidateLabel,
} from "./statusCopy";
import { useBlobUrl } from "./useBlobUrl";
import classes from "./InspectorSlot.module.css";

// Distinct glyph per terminal state (non-color-only), matching the contact-sheet card.
const TERMINAL_ICON: Record<string, string> = {
  failed: "⚠",
  interrupted: "◼",
  "cancel-requested": "◼",
};

export interface InspectorSlotProps {
  repo: SessionRepository;
  manifest: SessionManifest;
  focusedCandidateId: string | undefined;
  // Secondary tab (single-tab guard): disable Primary selection + export, which write to storage.
  readOnly?: boolean;
  // Feed a mutation back into run state so cards + inspector re-render (Primary badge).
  onManifestChange: (manifest: SessionManifest) => void;
  // The P3 "Edit setup" affordance, surfaced for a dead run's terminal recovery (P6 owns
  // the real edit-and-regenerate; this only reopens the form).
  onEditSetup: () => void;
}

// Cost display (source renderInspector semantics, P8 compact formatting): a real number
// (incl. a genuine calculated zero, "0.0¢") shows via the shared formatter; an
// unavailable/unknown cost is NEVER rendered as a number — status is checked FIRST so even
// a malformed {status:"unavailable", usd:0} record reads "Unavailable".
function costDisplay(candidate: CandidateRecord): string | undefined {
  const cost = candidate.cost;
  if (cost?.status !== "unavailable" && typeof cost?.usd === "number") {
    const prefix = cost.status === "upper-bound" ? "Up to " : "";
    const grounding = cost.excludesGrounding ? " (grounding not included)" : "";
    return `${prefix}${formatApproxCost(cost.usd)}${grounding}`;
  }
  if (candidate.cancellation?.billing === "unknown-may-be-charged") {
    return "Unknown; may have been charged";
  }
  if (cost?.status === "unavailable") return "Unavailable";
  return undefined;
}

// Source isTerminalRecoverySession: the WHOLE run is dead (no succeeded candidate) and the
// session reached a terminal status — only then do we offer recovery instead of Primary.
function isTerminalRecoverySession(manifest: SessionManifest): boolean {
  const candidates = manifest.arms.flatMap((arm) => arm.candidates);
  return (
    !candidates.some((candidate) => candidate.status === "succeeded") &&
    ["failed", "interrupted", "cancelled"].includes(manifest.status)
  );
}

// ---- Hover-zoom magnifier (P8, P10 natural-resolution scale) --------------------------
// Hovering the inspector preview shows a fixed-position zoom panel floating LEFT of the
// inspector column (portal to <body> — the sticky inspector column scrolls/clips its own
// overflow, so an absolutely-positioned child could not escape it). Plain backgroundPosition
// math over the same blob URL, no library. The panel exists ONLY while the cursor is over
// the image (hidden immediately on leave/scroll/resize); touch taps toggle it; there is no
// motion to reduce — it's an instant show/hide. Magnification (zoomScale.ts) is anchored to the
// image's NATURAL pixels, not the displayed preview size, so the FEEL never varies with viewport
// or layout WHENEVER the panel shows. Whether it can show at all is this placement logic's own,
// older (P8/P9, unchanged by P10) call: below, it skips entirely when neither side has room for
// a useful panel — in particular, the results layout's stacked mode (<1080px) renders the
// preview near edge-to-edge with no side gutter, so the panel never opens there at any width.
// The panel scales with the viewport (~30vw) like the generated images do, capped at 1.5×
// the old fixed 280px. Below the minimum the magnifier stops being useful — hide instead.
const ZOOM_PANEL_MAX = 420;
const ZOOM_PANEL_MIN = 200;
const ZOOM_GAP = 20;
const ZOOM_MARGIN = 8;

interface ZoomState {
  left: number;
  top: number;
  size: number;
  bgX: number;
  bgY: number;
  bgW: number;
  bgH: number;
}

function clampRange(value: number, min: number, max: number): number {
  // When the content is smaller than the window (min > max), center instead.
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

function ZoomableImage({ url, alt, meta }: { url: string; alt: string; meta: ImageMeta }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const rafRef = useRef(0);
  const touchToggled = useRef(false);
  const [zoom, setZoom] = useState<ZoomState | null>(null);

  const hide = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    touchToggled.current = false;
    setZoom(null);
  }, []);

  // Map a cursor position to a panel placement + background window. Returns null when the
  // cursor is outside the DISPLAYED image (object-fit: contain letterboxing) or when there
  // is no room for the panel on either side.
  const compute = useCallback(
    (clientX: number, clientY: number): ZoomState | null => {
      const img = imgRef.current;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const naturalW = meta.width || img.naturalWidth || rect.width;
      const naturalH = meta.height || img.naturalHeight || rect.height;
      // The contain-rect: where the image pixels actually render inside the square box.
      const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
      const dispW = naturalW * scale;
      const dispH = naturalH * scale;
      const offsetX = rect.left + (rect.width - dispW) / 2;
      const offsetY = rect.top + (rect.height - dispH) / 2;
      const x = clientX - offsetX;
      const y = clientY - offsetY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < 0 || y < 0 || x > dispW || y > dispH) return null;

      // Viewport-scaled panel size, shrunk into whichever side gap can host it. Prefer
      // floating left of the inspector column; fall back to the right on narrow layouts;
      // skip entirely when neither side fits a useful panel (never overlap the image).
      const desired = Math.min(
        ZOOM_PANEL_MAX,
        Math.round(window.innerWidth * 0.3),
        window.innerHeight - 2 * ZOOM_MARGIN,
      );
      const leftSpace = rect.left - ZOOM_GAP - ZOOM_MARGIN;
      const rightSpace = window.innerWidth - rect.right - ZOOM_GAP - ZOOM_MARGIN;
      let size: number;
      let left: number;
      if (Math.min(desired, leftSpace) >= ZOOM_PANEL_MIN) {
        size = Math.min(desired, leftSpace);
        left = rect.left - size - ZOOM_GAP;
      } else if (Math.min(desired, rightSpace) >= ZOOM_PANEL_MIN) {
        size = Math.min(desired, rightSpace);
        left = rect.right + ZOOM_GAP;
      } else {
        return null;
      }

      // bgW/bgH depend only on the NATURAL size + panel size (never dispW/dispH) — that's the
      // fix. The cursor's position within the DISPLAYED image still maps by fraction (x/dispW,
      // y/dispH) onto that natural-anchored background, unaffected by the scale change above.
      const { bgW, bgH } = computeZoomBackgroundSize(naturalW, naturalH, size);
      const bgX = clampRange(size / 2 - (x / dispW) * bgW, size - bgW, 0);
      const bgY = clampRange(size / 2 - (y / dispH) * bgH, size - bgH, 0);

      const top = clampRange(rect.top, ZOOM_MARGIN, window.innerHeight - size - ZOOM_MARGIN);
      return { left, top, size, bgX, bgY, bgW, bgH };
    },
    [meta.width, meta.height],
  );

  // While open: vanish on scroll/resize (the cached placement would go stale) and on Escape.
  const open = zoom !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, hide]);

  // Never leave a queued frame behind on unmount.
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <>
      <Image
        ref={imgRef}
        className={classes.preview}
        src={url}
        alt={alt}
        onPointerMove={(event) => {
          if (event.pointerType === "touch") return;
          const { clientX, clientY } = event;
          cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => setZoom(compute(clientX, clientY)));
        }}
        onPointerLeave={(event) => {
          // A tap-toggled panel survives the synthetic leave that follows a touch tap.
          if (event.pointerType === "touch" && touchToggled.current) return;
          hide();
        }}
        onPointerUp={(event) => {
          if (event.pointerType !== "touch") return;
          if (touchToggled.current) {
            hide();
          } else {
            const next = compute(event.clientX, event.clientY);
            touchToggled.current = next !== null;
            setZoom(next);
          }
        }}
      />
      {zoom &&
        createPortal(
          <div
            className={classes.zoomPanel}
            data-testid="zoom-panel"
            aria-hidden
            style={{
              left: zoom.left,
              top: zoom.top,
              width: zoom.size,
              height: zoom.size,
              backgroundImage: `url(${url})`,
              backgroundSize: `${zoom.bgW}px ${zoom.bgH}px`,
              backgroundPosition: `${zoom.bgX}px ${zoom.bgY}px`,
            }}
          />,
          document.body,
        )}
    </>
  );
}
// ----------------------------------------------------------------------------------------

// The succeeded candidate's preview: the large image plus (icon family only) the small-size
// previews. One leak-safe object URL (useBlobUrl) backs the large image AND all six small
// cells. Keyed by blobId in the parent so a focus change REMOUNTS this — otherwise the hook
// would return the previous candidate's URL for one render, flashing image A under identity B.
function CandidatePreview({
  repo,
  image,
  alt,
  iconSizes,
}: {
  repo: SessionRepository;
  image: ImageMeta;
  alt: string;
  // Present (and non-empty) only for the icon family — drives the "Small-size previews".
  iconSizes?: number[];
}) {
  const url = useBlobUrl(repo, image.blobId);

  return (
    <>
      {url ? (
        <ZoomableImage url={url} alt={alt} meta={image} />
      ) : (
        // Brief decode gap before the object URL resolves — a neutral square, never a stale
        // image from the previously focused candidate.
        <div className={classes.placeholder} aria-hidden />
      )}

      {/* Icon-family "Small-size previews": the icon judged at 80/96/112px on light AND dark
          cells (source nativePreview). Native <details> — no motion/state work. */}
      {url && iconSizes && iconSizes.length > 0 && (
        <details className={classes.nativeDetails}>
          <summary>Small-size previews</summary>
          <div className={classes.nativePreview} aria-label="Small-size previews">
            {iconSizes.map((px) => (
              <div key={px} className={classes.nativeRow}>
                <span>{px}px</span>
                <div className={`${classes.nativeCell} ${classes.nativeCellLight}`}>
                  <img src={url} width={px} height={px} alt="" />
                </div>
                <div className={`${classes.nativeCell} ${classes.nativeCellDark}`}>
                  <img src={url} width={px} height={px} alt="" />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

// Renders Google's Search Suggestions widget (searchEntryPoint.renderedContent) inside a SHADOW
// ROOT: the widget's inline <style> is scoped to the shadow tree so it cannot restyle the rest of
// the page, and scripts injected via innerHTML never execute (spec) — and are blocked by our CSP
// anyway. The widget was verified live to be self-contained HTML+CSS (inline <style>, inline SVG
// logo, <a href=google.com/search>) with no external resources.
function GroundingWidget({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = html;
    return () => {
      shadow.innerHTML = "";
    };
  }, [html]);
  return <div ref={ref} className={classes.groundingWidget} />;
}

// Google Search grounding attribution. When a candidate used grounding, Google requires showing
// the Search Suggestions (the shadow-isolated widget above) and source attribution (chips linking
// through Google's grounding-redirect URIs — already validated http(s) by the parser).
function GroundingAttribution({ grounding }: { grounding: NonNullable<CandidateRecord["grounding"]> }) {
  const { searchEntryPointHtml, webSearchQueries, sources } = grounding;
  return (
    <div>
      <Text component="h3" fz="sm" fw={700} mb={4}>
        Grounded with Google Search
      </Text>
      {searchEntryPointHtml ? (
        <GroundingWidget html={searchEntryPointHtml} />
      ) : (
        webSearchQueries.length > 0 && (
          // Fallback when the widget is absent: link the search queries to Google Search.
          <Group gap="xs" mb={sources.length ? "xs" : 0}>
            {webSearchQueries.map((query) => (
              <Anchor
                key={query}
                href={`https://www.google.com/search?q=${encodeURIComponent(query)}`}
                target="_blank"
                rel="noreferrer"
                fz="xs"
                className={classes.groundingChip}
              >
                {query}
              </Anchor>
            ))}
          </Group>
        )
      )}
      {sources.length > 0 && (
        <>
          <Text fz="xs" c="dimmed" mt="xs" mb={4}>
            Sources
          </Text>
          <Group gap="xs">
            {sources.map((source) => (
              <Anchor
                key={source.uri}
                href={source.uri}
                target="_blank"
                rel="noreferrer"
                fz="xs"
                className={classes.groundingChip}
                title={source.uri}
              >
                {source.title ?? new URL(source.uri).hostname}
              </Anchor>
            ))}
          </Group>
        </>
      )}
    </div>
  );
}

export function InspectorSlot({
  repo,
  manifest,
  focusedCandidateId,
  readOnly,
  onManifestChange,
  onEditSetup,
}: InspectorSlotProps) {
  const [pending, setPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Spinner state for the compressed-download button ONLY — its siblings disable (without
  // spinning) while it runs, and vice versa, so no button ever spins for another's work.
  const [compressing, setCompressing] = useState(false);

  const found = focusedCandidateId
    ? manifest.arms
        .flatMap((arm) => arm.candidates.map((candidate) => ({ arm, candidate })))
        .find((entry) => entry.candidate.id === focusedCandidateId)
    : undefined;

  if (!found) {
    return (
      <Paper p="md" radius="md" withBorder>
        <Text c="dimmed" fz="sm">
          Select a candidate to inspect it.
        </Text>
      </Paper>
    );
  }

  const { arm, candidate } = found;
  const identity = `${arm.recipe.name} → ${manifest.subject} → Variant ${candidate.variant} of ${arm.candidates.length}`;
  const terminalLabel = terminalCandidateLabel(candidate.status);
  const isFailed = candidate.status === "failed";
  const isPrimary = manifest.selectedCandidateId === candidate.id;
  const showRecovery = Boolean(terminalLabel) && isTerminalRecoverySession(manifest);
  const family = recipeFamily(arm.recipe);
  const isIcon = family === "icon";
  const ready = candidate.status === "succeeded" && candidate.images.length > 0;
  const image = candidate.images[0];
  // Compressed-download plan for the focused image's mime (undefined → raw only). The label
  // backfills from the per-blobId cache once a compression has completed; reading the cache
  // by the CURRENT blobId is the focus-change guard (a slow job for candidate A can never
  // label candidate B). The worker's alpha guard may flip a planned JPEG to PNG, so the
  // completed label/hint key on the RESULT mime, not the plan.
  const plan = image ? compressionPlan(image.mimeType, family) : undefined;
  const compressed = image && plan ? cachedCompression(image.blobId) : undefined;
  // Only-if-smaller rule: a compressed result that cannot beat raw is never downloadable.
  const noSmaller = Boolean(compressed && image && compressed.size >= image.bytes);
  const cost = costDisplay(candidate);
  const size = image
    ? `${image.width}×${image.height} · ${formatBytes(image.bytes)}`
    : formatSize(manifest.settings.size);
  const model = candidate.modelVersion ?? modelShortLabel(manifest.settings.modelId);
  // The friendly failure/interruption detail (source shows candidate.error for failed AND
  // interrupted/cancel-requested). Empty for succeeded/queued/running.
  const failureMessage = candidateFailureMessage(candidate);
  // Quiet notes (source candidateMessages): cancellation billing + non-square icon warning.
  const note = candidateMessage(arm, candidate);
  const iconSizes = isIcon && arm.recipe.preview.type === "folio-icon" ? arm.recipe.preview.sizes : undefined;
  // Icons generate at 1:1; a non-square icon can't be masked into a circle (source rejects it),
  // so its production/ZIP exports are disabled with a reason. Raw download stays available.
  const squareIcon = !isIcon || (image && image.width === image.height);
  const exportCount = manifest.exports.filter((entry) => entry.candidateId === candidate.id).length;

  // The focused candidate's raw generated image as a GeneratedImage, re-verifying the stored
  // bytes against the manifest (size + sha256, like buildExportBundle / source) before export.
  async function rawImage(): Promise<{ raw: GeneratedImage; source: ImageMeta }> {
    if (!image) throw new Error("Candidate has no image.");
    const blob = await repo.getBlob(image.blobId);
    if (!blob) throw new Error("Image bytes are unavailable.");
    if (blob.size !== image.bytes || (await sha256Hex(blob)) !== image.sha256) {
      throw new Error("Stored image no longer matches the manifest.");
    }
    return {
      source: image,
      raw: { blob, mimeType: image.mimeType, width: image.width, height: image.height, sha256: image.sha256 },
    };
  }

  // Build the artifact (may fail before download), trigger the download, THEN record best-effort
  // — a recording failure must not report the download as failed. Partial records are folded
  // back into run state and surfaced as a separate warning. `setBusy` picks which button
  // spins (default: the shared exporting flag); `produce` may resolve null to stop quietly
  // with no download (the compressed path's only-if-smaller rule — it notifies itself).
  async function runExport(
    label: string,
    produce: () => Promise<{ blob: Blob; filename: string; inputs: ExportInput[] } | null>,
    setBusy: (busy: boolean) => void = setExporting,
  ) {
    if (readOnly) return; // secondary tab: buttons are disabled, but never write from here
    setBusy(true);
    let produced;
    try {
      produced = await produce();
    } catch (error) {
      notifications.show({
        color: "red",
        title: `Could not ${label}`,
        message: error instanceof Error ? error.message : String(error),
      });
      setBusy(false);
      return;
    }
    if (!produced) {
      setBusy(false);
      return;
    }

    triggerDownload(produced.blob, produced.filename);
    let latest = manifest;
    let recordError: unknown;
    try {
      for (const input of produced.inputs) latest = await repo.recordExport(manifest.id, input);
    } catch (error) {
      recordError = error;
    }
    onManifestChange(latest);
    setBusy(false);
    if (recordError) {
      notifications.show({
        color: "yellow",
        title: "Downloaded; history not fully recorded",
        message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
  }

  const downloadRaw = () =>
    runExport("download the raw image", async () => {
      const { raw } = await rawImage();
      const filename = singleDownloadName(
        manifest.subject,
        arm.recipe.id,
        candidate.variant,
        "-raw",
        extensionForMime(raw.mimeType),
      );
      return { blob: raw.blob, filename, inputs: [{ candidateId: candidate.id, raw }] };
    });

  // Compress-on-click (cached per blobId, so later clicks are instant). The compressed blob
  // is recorded as the export's `production` image — a processed derivative, same slot the
  // icon path uses. If the result cannot beat raw, nothing downloads: the cache entry keeps
  // the size, so the button re-renders as a disabled "No smaller than raw".
  const downloadCompressed = () =>
    runExport(
      "download the compressed image",
      async () => {
        const { raw, source } = await rawImage();
        const result = await compressedFor(source.blobId, () =>
          compressImage(raw.blob, raw.mimeType, family, source),
        );
        if (result.blob.size >= raw.blob.size) {
          notifications.show({
            color: "yellow",
            title: "No smaller than raw",
            message: "Compression could not beat the raw file, so the raw download is the best option.",
          });
          return null;
        }
        const filename = singleDownloadName(
          manifest.subject,
          arm.recipe.id,
          candidate.variant,
          "-web",
          extensionForMime(result.mimeType),
        );
        return {
          blob: result.blob,
          filename,
          inputs: [{ candidateId: candidate.id, raw, production: result }],
        };
      },
      setCompressing,
    );

  // A single circular render at `size` (the primary ICON_SIZE, the fixed 256, or the
  // source's full resolution). The filename carries the actual pixel size.
  const downloadIcon = (size: number) =>
    runExport("generate the circular icon", async () => {
      const { raw } = await rawImage();
      const production = await exportCircularIcon(raw.blob, size);
      const filename = singleDownloadName(
        manifest.subject,
        arm.recipe.id,
        candidate.variant,
        `-icon-${production.width}`,
        ".png",
      );
      return {
        blob: production.blob,
        filename,
        inputs: [{ candidateId: candidate.id, raw, production }],
      };
    });

  // The complete per-candidate icon suite ZIP (raw + optimized source + circular renders);
  // recorded in history as ONE export event (raw + the shipped primary circle).
  const downloadSuite = () =>
    runExport("build the icon suite", async () => {
      const bundle = await buildIconSuiteBundle(repo, manifest, candidate.id);
      return {
        blob: new Blob([bundle.zip], { type: "application/zip" }),
        filename: bundle.filename,
        inputs: [bundle.recordInput],
      };
    });

  const downloadZip = () =>
    runExport("build the candidate ZIP", async () => {
      const bundle = await buildExportBundle(repo, manifest, [candidate.id]);
      return {
        blob: new Blob([bundle.zip], { type: "application/zip" }),
        filename: bundle.filename,
        inputs: bundleExportInputs(bundle),
      };
    });

  async function setPrimary(next: string | null) {
    if (readOnly) return; // secondary tab: never mutate shared storage
    setPending(true);
    try {
      onManifestChange(await repo.selectPrimary(manifest.id, next));
    } catch (error) {
      // selectPrimary throws for a non-succeeded candidate — the button is gated so this is
      // defensive. Surface it rather than silently swallowing.
      notifications.show({
        color: "red",
        title: "Could not set Primary",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Paper p="md" radius="md" withBorder>
      <Stack gap="sm">
        {/* role="list" keeps list semantics in Safari/VoiceOver despite list-style:none. */}
        <ol className={classes.identityPath} aria-label="Candidate identity" role="list">
          <li>{arm.recipe.name}</li>
          {/* Long prompts clamp at 3 lines. Nothing is lost: title carries the full text
              for hover/AT, and the expanded session view shows the subject in full. */}
          <li className={classes.subject} title={manifest.subject}>
            {manifest.subject}
          </li>
          <li>Variant {candidate.variant} of {arm.candidates.length}</li>
        </ol>

        {isPrimary && (
          <Badge
            variant="filled"
            radius="sm"
            leftSection={<span aria-hidden>★</span>}
            style={{ alignSelf: "flex-start" }}
          >
            Primary
          </Badge>
        )}

        {ready && image ? (
          // Keyed by blobId: a focus change remounts the preview, so no stale image flashes.
          <CandidatePreview
            key={image.blobId}
            repo={repo}
            image={image}
            alt={`Generated ${identity}`}
            iconSizes={iconSizes}
          />
        ) : terminalLabel ? (
          <div className={`${classes.placeholder}${isFailed ? ` ${classes.placeholderFailed}` : ""}`}>
            <span className={classes.placeholderIcon} aria-hidden>
              {TERMINAL_ICON[candidate.status] ?? "◼"}
            </span>
            <Text component="strong" fz="sm" fw={600} inherit>
              {terminalLabel}
            </Text>
          </div>
        ) : (
          <div className={classes.placeholder} aria-hidden>
            <span className={classes.placeholderIcon}>◻</span>
            <Text fz="sm" inherit>
              {statusLabel(candidate.status)}…
            </Text>
          </div>
        )}

        <div>
          <Text component="h3" fz="sm" fw={700} mb={4}>
            Status and cost
          </Text>
          <DataList orientation="horizontal" labelWidth={90} gap="xs" fz="sm">
            <DataList.Item>
              <DataList.ItemLabel>Status</DataList.ItemLabel>
              <DataList.ItemValue>{statusLabel(candidate.status)}</DataList.ItemValue>
            </DataList.Item>
            {cost && (
              <DataList.Item>
                <DataList.ItemLabel>Cost</DataList.ItemLabel>
                <DataList.ItemValue>{cost}</DataList.ItemValue>
              </DataList.Item>
            )}
            <DataList.Item>
              <DataList.ItemLabel>Model</DataList.ItemLabel>
              <DataList.ItemValue style={{ overflowWrap: "anywhere" }}>{model}</DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>Size</DataList.ItemLabel>
              <DataList.ItemValue>{size}</DataList.ItemValue>
            </DataList.Item>
          </DataList>
        </div>

        {failureMessage && (
          <Alert
            color={isFailed ? "red" : "gray"}
            variant="light"
            title={isFailed ? "Failure detail" : "Run interrupted"}
          >
            {/* P15: the finishReason explanations are 1-2 full sentences — read them at
                body size (md) instead of Alert's small default. Color is inherited from
                the Alert message (neutral black/white), same as before. */}
            <Text fz="md" lh={1.5}>
              {failureMessage}
            </Text>
          </Alert>
        )}

        {note && (
          <Text c="dimmed" fz="sm" style={{ overflowWrap: "anywhere" }}>
            {note}
          </Text>
        )}

        {candidate.grounding && <GroundingAttribution grounding={candidate.grounding} />}

        {showRecovery ? (
          <div>
            {/* Edit-and-regenerate with reference inheritance (P6): seed the form from this
                dead run so the user can adjust and retry without re-entering everything. */}
            <Text c="dimmed" fz="sm" mb="xs">
              This run produced no usable candidate.
            </Text>
            <Button onClick={onEditSetup}>Edit and regenerate</Button>
          </div>
        ) : (
          <>
            <div>
              {isPrimary && (
                <Text c="dimmed" fz="sm" mb="xs">
                  This is the Primary candidate for the run.
                </Text>
              )}
              {isPrimary ? (
                <Button variant="default" loading={pending} disabled={readOnly} onClick={() => void setPrimary(null)}>
                  Clear Primary
                </Button>
              ) : (
                <Button
                  loading={pending}
                  disabled={!ready || readOnly}
                  onClick={() => void setPrimary(candidate.id)}
                >
                  Set as Primary
                </Button>
              )}
            </div>

            {/* Per-candidate export (independent of the tray's multi-select and of Primary).
                The split button offers the raw image and, when the matrix has a codec for the
                mime, a smaller compressed copy (compressed on first click, cached per blobId);
                icons also offer the circular exports (512 primary, plus a size menu with full
                resolution, 256px, and the complete suite ZIP). Every download appends an
                export event to manifest.exports. */}
            <div>
              <Text component="h3" fz="sm" fw={700} mb="xs">
                Download or export
              </Text>
              {/* Full-width split control on its own row: the two segments share the column
                  (flex + minWidth 0), so a long backfilled size can never overflow the
                  narrow inspector; the label ellipsizes in the worst case instead. */}
              <Button.Group aria-label="Download the image" w="100%" mb="xs">
                <Button
                  variant="default"
                  loading={exporting}
                  disabled={!ready || readOnly || compressing}
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                  onClick={() => void downloadRaw()}
                >
                  {image ? `Raw · ${formatBytes(image.bytes)}` : "Download raw"}
                </Button>
                {plan && (
                  <Button
                    variant="default"
                    loading={compressing}
                    disabled={!ready || readOnly || exporting || noSmaller}
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                    onClick={() => void downloadCompressed()}
                  >
                    {/* P15: the post-compute label drops the format name ("Raw · N KB |
                        Small · M KB") — the full wording overflowed both segments at the
                        336px inspector width; the lossy/lossless honesty lives in the
                        hint below, keyed on the RESULT mime. */}
                    {noSmaller
                      ? "No smaller than raw"
                      : compressed
                        ? `Small · ${formatBytes(compressed.size)}`
                        : compressionLabel(plan.outputMime)}
                  </Button>
                )}
              </Button.Group>
              <Group gap="xs">
                {isIcon && image && (
                  /* Split control: the primary action downloads the ICON_SIZE circle; the
                     caret opens the size menu (full resolution, 256px, complete suite ZIP).
                     Every entry shares the primary's gating — disabled while any export or
                     compression runs, on a non-square source, and in a read-only tab — and
                     every action reports through the same runExport error/notification
                     machinery. The full-resolution item is hidden when the source IS the
                     primary size (it would duplicate the primary download). */
                  <Button.Group aria-label="Download circular icon">
                    <Button
                      loading={exporting}
                      disabled={!ready || !squareIcon || readOnly || compressing}
                      onClick={() => void downloadIcon(ICON_SIZE)}
                    >
                      Download circular icon · {ICON_SIZE}px
                    </Button>
                    <Menu position="bottom-end" shadow="md">
                      <Menu.Target>
                        {/* NOT disabled during `exporting`: the Menu returns focus to this
                            target when the dropdown closes, and a disabled target would drop
                            keyboard focus to <body> for the export a menu item just started.
                            The items themselves gate on `exporting`, so nothing is actionable
                            while one runs. */}
                        <Button
                          px="xs"
                          aria-label="More circular icon sizes"
                          disabled={!ready || !squareIcon || readOnly || compressing}
                        >
                          <CaretDown aria-hidden />
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {image.width !== ICON_SIZE && (
                          <Menu.Item
                            disabled={!ready || !squareIcon || readOnly || compressing || exporting}
                            onClick={() => void downloadIcon(image.width)}
                          >
                            Full resolution · {image.width}px
                          </Menu.Item>
                        )}
                        <Menu.Item
                          disabled={!ready || !squareIcon || readOnly || compressing || exporting}
                          onClick={() => void downloadIcon(256)}
                        >
                          256px
                        </Menu.Item>
                        <Menu.Item
                          disabled={!ready || !squareIcon || readOnly || compressing || exporting}
                          onClick={() => void downloadSuite()}
                        >
                          Complete suite (ZIP)
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Button.Group>
                )}
                <Button
                  variant="default"
                  loading={exporting}
                  disabled={!ready || !squareIcon || readOnly || compressing}
                  onClick={() => void downloadZip()}
                >
                  Download candidate as ZIP
                </Button>
              </Group>
              {plan && (
                <Text c="dimmed" fz="sm" mt="xs">
                  {compressionHint(compressed?.mimeType ?? plan.outputMime)}
                </Text>
              )}
              {readOnly && (
                <Text c="dimmed" fz="sm" mt="xs">
                  BYOBanana is open in another tab. Primary and export are disabled here to avoid
                  racing that tab. Use the original tab, or close it and reload this one.
                </Text>
              )}
              {isIcon && !squareIcon && ready && (
                <Text c="dimmed" fz="sm" mt="xs">
                  Project icons require a square generated image; only the raw download is
                  available for this candidate.
                </Text>
              )}
              {exportCount > 0 && (
                <Text c="dimmed" fz="sm" mt="xs">
                  Exported {exportCount} time{exportCount === 1 ? "" : "s"}.
                </Text>
              )}
            </div>
          </>
        )}
      </Stack>
    </Paper>
  );
}

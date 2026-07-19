// Header spend pill + popover (nano-banana-2 web/app.js renderSpend / spend popover). Shows
// realized spend aggregated across ALL stored sessions: a split-flap "departure board" on
// the pill (P12), and a per-model breakdown (generated-image counts + caveats) in a
// dismiss-on-click-away Popover.
//
// P12 — the split-flap board (R3 look since P16: 16×24 cells, scheme-inverting faces, a
// static decimal flap, a bare teal $, runtime seam centering): known dollars render as
// vertical digit strips in flap board cells. While a run is live (Workbench `busy`) the columns roll continuously (Mode A:
// mid-run partials never retarget the spin), the coin spins and the pill wears a teal
// ring; on the confirmed final aggregate the columns settle left → right with a clack.
// The board is an IMPERATIVE DOM island: React renders only the container span, and the
// engine below owns cells/strips/timers in refs — so frequent `sessions` re-renders can
// never clobber a mid-flight animation, and the falling-edge freeze (read the loop's
// computed transform, then retarget) needs no render choreography. All strip math is
// pure and tested in flapMath.ts.
//
// Honesty rules (ported): an unavailable/unknown cost is NEVER shown as a resting "$0" —
// committed digit cells appear only when the total folds to real known dollars; every
// other non-live outcome is plain text ("Cost unavailable", "May have charges", "$0.00"
// only for a genuinely-empty stored run). At rest with no folded dollars the pill is an
// explicit unknown board — the same flap frame with a "$" and dash placeholders
// ("$ -.--"), idle, no committed cells, no popover. While a run is in flight with no
// known dollars yet the board stays present and ROLLS (motion texture under a veil, no
// committed value, no data-digit) instead of swapping to a text "Calculating…" — never a
// resting fake number; under reduced motion the same state is the static dash board.
//
// The visible pill face shows only the bare folded dollar total; the "up to" ceiling
// qualifier lives in the popover (total line + per-model rows) and the accessible
// labels, not on the board face.
//
// Accessibility: the board is aria-hidden; the button keeps a STABLE label while a run
// is live ("calculating", never per-partial); a single polite atomic live region
// announces once per genuine active → settled edge (cleared on run start so identical
// totals re-announce; generation-guarded; silent on mount/StrictMode). Reduced motion
// fully disables the loop/settle/clack/coin-spin — values change instantly — and the
// preference is subscribed, so an OS-level flip mid-run stops (or resumes) the board.

import {
  Badge,
  Divider,
  Group,
  Popover,
  Stack,
  Text,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { Coins } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { SessionSummary } from "../core/session";
import {
  boardDigits,
  CELL_HEIGHT,
  GRAND_STAGGER_MS,
  grandTarget,
  homeJ,
  loopStart,
  QUICK_STAGGER_MS,
  quickTarget,
  spendBoardValue,
  STRIP_GLYPHS,
} from "./flapMath";
import { aggregateSpend, type SpendAccumulator } from "./spendAggregate";
import classes from "./SpendPill.module.css";

export interface SpendPillProps {
  sessions: SessionSummary[];
  // True while a generation run is in flight (Workbench `busy`) — drives the live state.
  active?: boolean;
}

// The headline shared by the pill's accessible label and the popover: known dollars
// (calculated + upper bound folded together — the "up to" granularity stays in the
// popover rows), never "$0" for unavailable/unknown spend. Grounding-only caveats (a
// grounded request cancelled before costing) also read "Cost unavailable" — the
// never-fake-$0 rule; only a genuinely empty stored run reads "$0.00".
function totalSpendHeadline(total: SpendAccumulator): string {
  if (total.hasCalculatedUsd || total.hasUpperBoundUsd) {
    return `$${(total.calculatedUsd + total.upperBoundUsd).toFixed(2)}`;
  }
  if (total.unknownMayBeChargedCount > 0) return "May have charges";
  if (total.unavailable || total.unavailableCount > 0 || total.unknownGroundingChargeCount > 0) {
    return "Cost unavailable";
  }
  return "$0.00";
}

// ---------------------------------------------------------------------------------------
// The flap engine. Plain-DOM state in refs (never React state): cells, strip positions,
// the visual phase machine, timer/rAF handles, and an operation generation counter —
// every scheduled callback captures the generation and no-ops if superseded, so a new
// run starting mid-settle (or an unmount, or a reduced-motion flip) can never fire a
// stale retarget or announcement. Nothing relies on animationend/transitionend (Safari/
// reduced-motion/unmount can swallow them) — completions are setTimeout with known
// durations.
// ---------------------------------------------------------------------------------------

type FlapPhase = "idle" | "rolling" | "settling";

interface CellRec {
  el: HTMLSpanElement;
  strip: HTMLSpanElement;
  j: number; // last committed strip index (the target of the last motion)
  digit: number; // the digit this cell logically shows (mirrored to data-digit)
}

interface Engine {
  board: HTMLSpanElement | null;
  sym: HTMLSpanElement | null;
  sep: HTMLSpanElement | null;
  cells: CellRec[];
  phase: FlapPhase;
  gen: number;
  timers: Set<ReturnType<typeof setTimeout>>;
  rafs: Set<number>;
  value: string | null; // the value the cells currently represent
  pendingAnnounce: string | null;
  prevActive: boolean;
  prevReduced: boolean;
}

function cancelAll(e: Engine): void {
  for (const timer of e.timers) clearTimeout(timer);
  e.timers.clear();
  for (const raf of e.rafs) cancelAnimationFrame(raf);
  e.rafs.clear();
  // The cancelled callbacks include the cosmetic cleanups (entry-fade rAFs, clack
  // removal), so strip those classes here or an interrupted cell stays invisible
  // (`pre` is opacity 0) or stuck mid-nudge. `rolling` is deliberately KEPT — the
  // next operation freezes each cell from its live computed transform first.
  for (const rec of e.cells) rec.el.classList.remove(classes.pre, classes.clack);
}

// Generation-guarded setTimeout: fires only if no start/settle/retarget superseded it.
function later(e: Engine, fn: () => void, ms: number): void {
  const gen = e.gen;
  const id = setTimeout(() => {
    e.timers.delete(id);
    if (e.gen === gen) fn();
  }, ms);
  e.timers.add(id);
}

function makeSpan(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

function setCellDigit(rec: CellRec, digit: number): void {
  rec.digit = digit;
  rec.el.dataset.digit = String(digit);
}

// The decimal separator: a STATIC flap cell (P16/R3) — same card chrome and the SAME
// cell width as a digit cell, a one-glyph strip that never rolls or clacks (real boards
// mount punctuation on a card but don't flap it). Never in e.cells, so the engine can't
// animate it, and it has no data-digit, so digit-cell selectors (tests, harnesses) skip it.
function makeDotCell(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `${classes.cell} ${classes.static} ${classes.dotcell}`;
  const strip = document.createElement("span");
  strip.className = classes.strip;
  strip.appendChild(makeSpan(classes.glyph, "."));
  el.appendChild(strip);
  return el;
}

function makeCell(digit: number, entering: boolean): CellRec {
  const el = document.createElement("span");
  el.className = entering ? `${classes.cell} ${classes.pre}` : classes.cell;
  const strip = document.createElement("span");
  strip.className = classes.strip;
  for (const glyph of STRIP_GLYPHS) strip.appendChild(makeSpan(classes.glyph, glyph));
  strip.style.setProperty("--j", String(homeJ(digit)));
  el.appendChild(strip);
  const rec: CellRec = { el, strip, j: homeJ(digit), digit };
  setCellDigit(rec, digit);
  return rec;
}

// The strip's live position. While the CSS loop (or a settle transition) is running the
// computed transform is the truth; jsdom (no DOMMatrixReadOnly) and freshly-homed cells
// fall back to the tracked index.
function readCurrentJ(rec: CellRec): number {
  if (typeof DOMMatrixReadOnly === "undefined") return rec.j;
  try {
    const transform = getComputedStyle(rec.strip).transform;
    if (!transform || transform === "none") return rec.j;
    const j = -new DOMMatrixReadOnly(transform).m42 / CELL_HEIGHT;
    return Number.isFinite(j) ? j : rec.j;
  } catch {
    return rec.j;
  }
}

// Reconcile the board's cells to a value string. Cells are keyed by decimal place from
// the RIGHT (the formatter is always toFixed(2)), so digit-count growth inserts new
// cells at the LEFT and the ones/cents cells keep identity and motion. New cells claim
// their full width immediately and (when animating) fade/scale in; shrink is instant
// (only reachable via history deletion).
function reconcile(e: Engine, valueStr: string, entering: boolean, spinning: boolean): void {
  const board = e.board;
  if (!board) return;
  if (!e.sym) {
    e.sym = makeSpan(classes.sym, "$");
    board.appendChild(e.sym);
  }
  const digitCount = valueStr.replace(".", "").length;
  const have = e.cells.length;
  if (digitCount < have) {
    for (const rec of e.cells.splice(0, have - digitCount)) rec.el.remove();
  } else if (digitCount > have) {
    const anchor = e.cells[0]?.el ?? e.sep ?? null;
    for (let n = 0; n < digitCount - have; n += 1) {
      const rec = makeCell(0, entering);
      if (spinning) startCellRoll(rec);
      board.insertBefore(rec.el, anchor);
      e.cells.splice(n, 0, rec);
      if (entering) {
        // Two rAFs so the `pre` frame paints before the fade/scale-in transition runs.
        // Not generation-guarded: removing the entering class is cosmetic and always safe.
        const first = requestAnimationFrame(() => {
          e.rafs.delete(first);
          const second = requestAnimationFrame(() => {
            e.rafs.delete(second);
            rec.el.classList.remove(classes.pre);
          });
          e.rafs.add(second);
        });
        e.rafs.add(first);
      }
    }
  }
  // Decimal separator: always 2 cells from the right.
  e.sep?.remove();
  if (!e.sep) e.sep = makeDotCell();
  board.insertBefore(e.sep, e.cells[e.cells.length - 2]?.el ?? null);
}

// Snap every cell to the truth, killing any motion. The reduced-motion path and the
// initial mount both land here.
function setInstant(e: Engine, valueStr: string): void {
  reconcile(e, valueStr, false, false);
  const digits = boardDigits(valueStr);
  e.cells.forEach((rec, i) => {
    rec.strip.style.transition = "none";
    rec.strip.style.removeProperty("--dur");
    rec.strip.style.removeProperty("--ph");
    rec.strip.style.setProperty("--j", String(homeJ(digits[i])));
    rec.j = homeJ(digits[i]);
    setCellDigit(rec, digits[i]);
    rec.el.classList.remove(classes.rolling, classes.pre, classes.clack);
  });
  e.value = valueStr;
  e.phase = "idle";
}

// Start one cell's continuous CSS loop at the frame showing its CURRENT digit (no
// jump-cut): per-cell jittered duration desynchronizes columns; a computed negative
// delay phases the loop onto the current glyph. Zero JS per frame while rolling.
function startCellRoll(rec: CellRec): void {
  const jCur = readCurrentJ(rec); // freeze from the live transform — a run may start mid-settle
  const { ja, phaseFraction } = loopStart(jCur);
  const duration = 560 + Math.random() * 240;
  rec.strip.style.transition = "none";
  rec.strip.style.setProperty("--dur", `${Math.round(duration)}ms`);
  rec.strip.style.setProperty("--ph", `${-Math.round(phaseFraction * duration)}ms`);
  rec.j = ja;
  rec.el.classList.add(classes.rolling);
}

function startSpin(e: Engine): void {
  for (const rec of e.cells) startCellRoll(rec);
  e.phase = "rolling";
}

// After any landing, silently re-home the strip to the bottom decade (same digit,
// invisible) so every future roll has forward travel room.
function rehome(rec: CellRec): void {
  rec.strip.style.transition = "none";
  rec.strip.style.setProperty("--j", String(homeJ(rec.digit)));
  rec.j = homeJ(rec.digit);
}

function landCell(e: Engine, rec: CellRec, durationMs: number): void {
  later(
    e,
    () => {
      rec.el.classList.add(classes.clack);
      later(
        e,
        () => {
          rec.el.classList.remove(classes.clack);
          rehome(rec);
        },
        180,
      );
    },
    durationMs,
  );
}

// GRAND settle from the continuous spin: freeze each column where it is (computed
// transform), then roll it forward onto its target with distance-proportional easing,
// staggered left → right (slot-machine convention: big digits lock first, cents land
// last). jCur ∈ [20,30] (caught mid-loop) or a home position [20,29] (fresh/idle
// cells), so grandTarget stays on-strip by construction — verified exhaustively in
// flapMath.test.ts. Returns when the last column has landed.
function settleGrand(e: Engine, valueStr: string): number {
  reconcile(e, valueStr, true, false);
  e.value = valueStr;
  e.phase = "settling";
  const digits = boardDigits(valueStr);
  let lastLand = 0;
  e.cells.forEach((rec, i) => {
    const delay = 60 + i * GRAND_STAGGER_MS;
    later(
      e,
      () => {
        const jCur = readCurrentJ(rec);
        rec.strip.style.transition = "none";
        rec.strip.style.setProperty("--j", jCur.toFixed(3));
        rec.el.classList.remove(classes.rolling);
        rec.strip.style.removeProperty("--dur");
        rec.strip.style.removeProperty("--ph");
        void rec.strip.offsetHeight; // commit the frozen frame before transitioning
        const { jT, durationMs } = grandTarget(jCur, digits[i]);
        rec.strip.style.transition = `transform ${durationMs}ms cubic-bezier(.23,.72,.28,1)`;
        rec.strip.style.setProperty("--j", String(jT));
        rec.j = jT;
        setCellDigit(rec, digits[i]);
        landCell(e, rec, durationMs);
      },
      delay,
    );
    lastLand = Math.max(lastLand, delay + 1240);
  });
  return lastLand;
}

// QUICK roll between two genuine values (idle corrective updates — history deletion, a
// post-settle refresh): only changed columns move, right → left, whole response
// < ~450ms. Interrupted cells are frozen at their current transform before retargeting;
// a cell caught too far up the strip for forward room snaps to its digit's home first.
function settleQuick(e: Engine, valueStr: string): number {
  reconcile(e, valueStr, true, false);
  e.value = valueStr;
  const digits = boardDigits(valueStr);
  let lastLand = 0;
  let k = 0;
  for (let i = e.cells.length - 1; i >= 0; i -= 1) {
    const rec = e.cells[i];
    const digit = digits[i];
    if (rec.digit === digit && !rec.el.classList.contains(classes.pre)) continue;
    const delay = k * QUICK_STAGGER_MS;
    k += 1;
    later(
      e,
      () => {
        let jCur = readCurrentJ(rec);
        if (jCur < 12) jCur = homeJ(rec.digit); // no forward room mid-flight: silent re-home
        rec.strip.style.transition = "none";
        rec.strip.style.setProperty("--j", jCur.toFixed(3));
        void rec.strip.offsetHeight;
        const { jT, durationMs } = quickTarget(jCur, digit);
        rec.strip.style.transition = `transform ${durationMs}ms cubic-bezier(.3,.7,.3,1)`;
        rec.strip.style.setProperty("--j", String(jT));
        rec.j = jT;
        setCellDigit(rec, digit);
        landCell(e, rec, durationMs);
      },
      delay,
    );
    lastLand = Math.max(lastLand, delay + 700);
  }
  return lastLand;
}

// Optical seam centering (P16/R3). place-items centers each glyph's 1em LINE BOX in its
// cell, but the ink is not centered inside its line box — it hangs off the baseline,
// whose position within the line box is a font metric that differs per fallback font.
// Two direct measurements at the REAL rendered size, no trusted constants:
//   1) baseline: a 0×0 inline-block strut sits ON the text baseline — measure where the
//      browser really put it inside a replica of the glyph box (DOM layout truth; canvas
//      fontBoundingBox* often disagrees with layout).
//   2) ink band: canvas measureText(...).actualBoundingBox* at the same font — the
//      baseline-relative ink extents as actually rasterized (hinting included).
// Digits optically span baseline → cap height (the tiny overshoot of round glyphs below
// the baseline / above the cap is a type-design optical correction and must NOT count),
// so their optical middle is baseline − capAscent/2 and
//   nudge = cellHeight/2 − baseline + capAscent/2
// puts it exactly on the 50% hinge — for any font and any cell/font size. The larger $
// centers its FULL ink band instead (its bar genuinely overshoots both ways), via
// includeDescent. Rounded to the device-pixel grid (finer is invisible; integers are too
// coarse). Returns null (→ CSS 0px fallback) when metrics are unavailable (jsdom).
function measureNudge(el: HTMLElement, inkText: string, includeDescent: boolean): number | null {
  // jsdom: HTMLCanvasElement.getContext logs a "not implemented" error before returning
  // null, so gate on the canvas API actually existing (Codex T1).
  if (typeof CanvasRenderingContext2D === "undefined") return null;
  const cs = getComputedStyle(el);
  const cellHeight = Number.parseFloat(cs.height);
  if (!Number.isFinite(cellHeight) || cellHeight <= 0) return null;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;display:grid;place-items:center;" +
    `width:${cs.width};height:${cs.height};` +
    `font:${cs.fontWeight} ${cs.fontSize}/1 ${cs.fontFamily};`;
  const line = document.createElement("span");
  line.textContent = "0";
  const strut = document.createElement("i");
  strut.style.cssText = "display:inline-block;width:0;height:0;";
  line.appendChild(strut);
  probe.appendChild(line);
  document.body.appendChild(probe);
  const baseline = strut.getBoundingClientRect().bottom - probe.getBoundingClientRect().top;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const metrics = ctx.measureText(inkText);
  const ascent = metrics.actualBoundingBoxAscent;
  const descent = includeDescent ? metrics.actualBoundingBoxDescent : 0;
  if (!Number.isFinite(baseline) || !Number.isFinite(ascent) || ascent <= 0) return null;
  if (!Number.isFinite(descent)) return null;
  const nudge = cellHeight / 2 - baseline + (ascent - descent) / 2;
  const grid = window.devicePixelRatio || 1;
  return Math.round(nudge * grid) / grid;
}

// Measure and write both nudges as CSS vars on the .board element (not :root — the vars
// are board-local). Idempotent; safe to re-run (StrictMode, fonts.ready).
function applySeamNudge(board: HTMLSpanElement): void {
  const glyph = board.getElementsByClassName(classes.glyph)[0];
  if (glyph instanceof HTMLElement) {
    const nudge = measureNudge(glyph, "0123456789", false);
    if (nudge !== null) board.style.setProperty("--seam-nudge", `${nudge.toFixed(3)}px`);
  }
  const sym = board.getElementsByClassName(classes.sym)[0];
  if (sym instanceof HTMLElement) {
    const nudge = measureNudge(sym, "$", true);
    if (nudge !== null) board.style.setProperty("--sym-nudge", `${nudge.toFixed(3)}px`);
  }
}

// The React seam: one effect watches the [active, value, reduced] edges and drives the
// engine. `value` is the board-eligible dollar string (or null); `announceText` is the
// once-per-settle live-region sentence (read through a ref so the falling edge always
// announces the freshest total).
function useFlapBoard(
  value: string | null,
  announceText: string | null,
  active: boolean,
  reduced: boolean,
): { boardRef: React.RefObject<HTMLSpanElement | null>; liveText: string } {
  const boardRef = useRef<HTMLSpanElement | null>(null);
  const [liveText, setLiveText] = useState("");
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) {
    engineRef.current = {
      board: null,
      sym: null,
      sep: null,
      cells: [],
      phase: "idle",
      gen: 0,
      timers: new Set(),
      rafs: new Set(),
      value: null,
      pendingAnnounce: null,
      prevActive: active,
      prevReduced: reduced,
    };
  }
  const valueRef = useRef(value);
  valueRef.current = value;
  const announceRef = useRef(announceText);
  announceRef.current = announceText;

  // Layout effect (Codex T1): attach/reconcile before paint, so the board is never
  // painted empty on mount and edge reactions land in the same frame as the render.
  useLayoutEffect(() => {
    const e = engineRef.current!;
    const board = boardRef.current;

    // Container (un)mounted or replaced (board ↔ text fallback): reset bookkeeping.
    // StrictMode's double effect run passes the SAME element and displayed value, so
    // this branch is skipped and the run is idempotent.
    if (board !== e.board) {
      e.gen += 1;
      cancelAll(e);
      e.board = board;
      e.sym = null;
      e.sep = null;
      e.cells = [];
      e.value = null;
      e.phase = "idle";
      if (board) {
        board.textContent = "";
        // Cell height single source (P14): flapMath.CELL_HEIGHT drives both the strip
        // math (readCurrentJ) and, via --ch here, every CSS transform/keyframe.
        board.style.setProperty("--ch", `${CELL_HEIGHT}px`);
      }
    }

    const rising = active && !e.prevActive;
    const falling = !active && e.prevActive;
    e.prevActive = active;
    const reducedFlipped = reduced !== e.prevReduced;
    e.prevReduced = reduced;

    // Preference flip first: →reduced cancels every timer and snaps to truth (flushing
    // any pending settle announcement immediately); →unreduced while live resumes the
    // roll from truthful positions.
    if (reducedFlipped) {
      e.gen += 1;
      cancelAll(e);
      if (reduced) {
        if (board && value !== null) setInstant(e, value);
        else e.phase = "idle";
        if (e.pendingAnnounce !== null) {
          // Complete the interrupted settle's announcement now, with the fresh total.
          setLiveText(announceRef.current ?? e.pendingAnnounce);
          e.pendingAnnounce = null;
        }
      } else if (active && board && value !== null) {
        if (e.value === null) setInstant(e, value);
        startSpin(e);
      }
    }

    if (rising) {
      e.gen += 1;
      cancelAll(e);
      e.pendingAnnounce = null;
      // Clear the region so two consecutive runs with identical totals both announce
      // (identical text does not re-fire aria-live).
      setLiveText("");
      if (board && value !== null) {
        if (e.value === null || reduced) setInstant(e, value);
        else reconcile(e, value, false, false);
        if (!reduced) startSpin(e);
      }
      return;
    }

    if (falling) {
      e.gen += 1;
      cancelAll(e);
      const announce = announceRef.current;
      e.pendingAnnounce = null;
      if (!board || value === null) {
        // Honest non-numeric outcome: text fallback (rendered by React) + announce now.
        e.phase = "idle";
        if (announce !== null) setLiveText(announce);
        return;
      }
      if (reduced) {
        setInstant(e, value);
        if (announce !== null) setLiveText(announce);
        return;
      }
      const wait = settleGrand(e, value);
      e.pendingAnnounce = announce;
      later(
        e,
        () => {
          e.phase = "idle";
          e.pendingAnnounce = null;
          // Belt & braces: a sessions update that changed the total after the settle
          // began plays a quick corrective roll FIRST, and the single announcement
          // then carries the FRESH total (Codex T2: announcing the captured value
          // before correcting would leave screen readers holding the stale figure).
          const latest = valueRef.current;
          if (latest !== null && latest !== e.value) settleQuick(e, latest);
          const fresh = announceRef.current ?? announce;
          if (fresh !== null) setLiveText(fresh);
        },
        wait,
      );
      return;
    }

    // Steady state (no active edge).
    if (active) {
      // Mode A ignores mid-run partials — EXCEPT zero cells → first genuine dollars
      // (a run over an empty ledger): build the board and start it rolling.
      if (board && value !== null && e.value === null) {
        setInstant(e, value);
        if (!reduced) startSpin(e);
      }
      return;
    }
    if (board && value !== null && e.value !== value) {
      if (e.value === null) {
        setInstant(e, value); // initial history load: no animation
      } else if (e.phase === "idle") {
        // Idle corrective update (deletion / late refresh): quick roll to the truth.
        e.gen += 1;
        cancelAll(e);
        if (reduced) setInstant(e, value);
        else settleQuick(e, value);
      }
      // phase === "settling": the settle-completion callback re-checks valueRef.
    }
  }, [active, value, reduced]);

  // Seam centering: measure once the board exists with cells (mount, or a board first
  // appearing mid-run — value flips null → string) and re-measure when the font set
  // settles (a late-loading font can swap metrics). Declared AFTER the engine effect, so
  // the cells are in the DOM when it runs. Do NOT bake a constant: the nudge is
  // font-metric-sensitive (mono vs sans differ by ~1px here).
  const hasBoard = value !== null;
  useLayoutEffect(() => {
    if (!hasBoard) return;
    const board = boardRef.current;
    if (!board) return;
    applySeamNudge(board);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      // Guard the async hop: only re-measure the same still-mounted board (Codex T1).
      if (!cancelled && boardRef.current === board) applySeamNudge(board);
    });
    return () => {
      cancelled = true;
    };
  }, [hasBoard]);

  // Unmount (and StrictMode's simulated remount): kill every timer/rAF.
  useEffect(() => {
    const e = engineRef.current!;
    return () => {
      e.gen += 1;
      cancelAll(e);
    };
  }, []);

  return { boardRef, liveText };
}

function CoinDisc() {
  return (
    <span className={classes.coin} aria-hidden>
      <Coins size={11} weight="bold" />
    </span>
  );
}

// The unknown/placeholder board: the real departure-board frame in the MINIMUM real shape
// (toFixed(2) is always ≥ "0.00", so three digit cells + the decimal card), with the same
// cell chrome, width, --ch, and runtime seam-centering as a real value — so when the first
// stored dollars appear the board swaps in at identical geometry, no width jump. aria-hidden
// as one blob; the pill's label carries meaning.
//   • At rest (`rolling` false): STATIC dash cells ("$ -.--") — an explicit "no spend
//     recorded yet" state. Dashes, not a fake "$0.00" (honesty rule). No data-digit.
//   • Live with no known dollars yet (`rolling` true): the three digit positions ROLL
//     continuously as honest motion texture (dimmed by the veil, no committed value, NO
//     data-digit so the engine + digit-cell selectors skip them) instead of a text
//     "Calculating…". Each rolling strip's RESTING frame is the "-" glyph appended at
//     index 31 (with base --j:31), so if the CSS loop is ever halted before React reacts
//     to a reduced-motion flip the cell shows a dash, never a resting fake "0". The loop
//     itself sweeps indices 30 → 20 (digits); the "-" is only the rest position.
// The decimal separator is always a STATIC dot card in both modes.
function UnknownBoard({ rolling = false }: { rolling?: boolean }) {
  const boardRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    board.style.setProperty("--ch", `${CELL_HEIGHT}px`);
    applySeamNudge(board);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled && boardRef.current === board) applySeamNudge(board);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Desync the rolling columns with a per-cell jittered duration + phase, set imperatively
  // (Math.random() during render would restart the roll on every parent re-render — and a
  // live run re-renders this pill on every `sessions` change). Runs only when `rolling`
  // flips on; the inline base --j:31 keeps each strip's rest frame on the "-" glyph.
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board || !rolling) return;
    for (const cell of board.getElementsByClassName(classes.rolling)) {
      const strip = cell.firstElementChild;
      if (!(strip instanceof HTMLElement)) continue;
      const duration = 560 + Math.random() * 240;
      strip.style.setProperty("--dur", `${Math.round(duration)}ms`);
      strip.style.setProperty("--ph", `${-Math.round(Math.random() * duration)}ms`);
    }
  }, [rolling]);
  const rollCell = (key: string) => (
    <span key={key} className={`${classes.cell} ${classes.rolling}`}>
      <span className={classes.strip} style={{ "--j": 31 } as CSSProperties}>
        {STRIP_GLYPHS.map((glyph, i) => (
          <span key={i} className={classes.glyph}>
            {glyph}
          </span>
        ))}
        <span key="rest" className={classes.glyph}>
          -
        </span>
      </span>
    </span>
  );
  const staticCell = (key: string, glyph: string, dot: boolean) => (
    <span
      key={key}
      className={`${classes.cell} ${classes.static}${dot ? ` ${classes.dotcell}` : ""}`}
    >
      <span className={classes.strip}>
        <span className={classes.glyph}>{glyph}</span>
      </span>
    </span>
  );
  return (
    <span className={`${classes.board} ${classes.unknownBoard}`} aria-hidden ref={boardRef}>
      <span className={classes.sym}>$</span>
      {rolling ? rollCell("d0") : staticCell("d0", "-", false)}
      {staticCell("dot", ".", true)}
      {rolling ? rollCell("d1") : staticCell("d1", "-", false)}
      {rolling ? rollCell("d2") : staticCell("d2", "-", false)}
    </span>
  );
}

export function SpendPill({ sessions, active = false }: SpendPillProps) {
  // Hooks run unconditionally BEFORE the zero-session branch: a live run takes the app
  // from 0 sessions to 1 while mounted, which would otherwise violate hook order.
  const reduced = useReducedMotion(false, { getInitialValueInEffect: false }) ?? false;
  const hasSessions = sessions.length > 0;
  const report = hasSessions ? aggregateSpend(sessions) : null;
  const value = report ? spendBoardValue(report.total) : null;
  const headline = report ? totalSpendHeadline(report.total) : null;
  // An estimated (upper-bound) component folded into the board figure makes the bare
  // "$X.XX" read as exact. The pill FACE stays bare, but the accessible label then says
  // "up to" so a focused control never reads a ceiling as exact (exact-only totals stay
  // bare). hasUpperBoundUsd is the "any estimate folded in" bit; exact-only folds leave it
  // false. (The popover total + rows keep "up to" unconditionally via formatSpend.)
  const estimated = report ? report.total.hasUpperBoundUsd : false;
  // The once-per-settle announcement: real dollars (with the "up to" qualifier when the
  // fold includes an estimate), or the honest non-numeric outcome.
  const announceText = report
    ? value !== null
      ? `Total spend ${estimated ? "up to " : ""}$${value}`
      : headline
    : null;
  const { boardRef, liveText } = useFlapBoard(value, announceText, active, reduced);

  const pillClass = `${classes.pill}${active ? ` ${classes.active}` : ""}`;
  // Mounted independent of the zero-session/popover branches (same fragment position in
  // both returns, so React preserves the node across the branch switch mid-run).
  const liveRegion = (
    <VisuallyHidden aria-live="polite" aria-atomic="true">
      {liveText}
    </VisuallyHidden>
  );

  if (!hasSessions) {
    // Empty ledger: a static non-button pill, no popover, NO committed digit cells (never a
    // fake $0) — an explicit unknown board "$ -.--" in the real flap frame (so the first
    // stored run settles with no width jump). While a first run is in flight the same board
    // ROLLS as honest motion texture (no committed value), or stays a static dash board
    // under reduced motion — never a text swap.
    return (
      <>
        {liveRegion}
        {/* role="img": a bare <span> has the implicit `generic` role, which prohibits an
            author name, so AT would drop the aria-label and expose only the visible "Total
            spend" (Codex R6). `img` is nameable and collapses the coin + word + dash board
            into one graphic whose accessible name is the label below. */}
        <span
          className={pillClass}
          data-spend-pill
          data-live={active ? "true" : undefined}
          role="img"
          aria-label={active ? "Total spend calculating" : "Total spend: none recorded yet"}
        >
          <CoinDisc />
          <span className={classes.word}>Total spend</span>
          <UnknownBoard rolling={active && !reduced} />
        </span>
      </>
    );
  }

  // While live the label is STABLE (never updated per partial — a focused control must
  // not re-announce); at rest it carries the folded headline. Label-in-name (WCAG
  // 2.5.3): the accessible name starts with the visible "Total spend" micro-label.
  const buttonLabel = active
    ? "Total spend: calculating. Open breakdown for all stored runs."
    : `Total spend: ${estimated ? "up to " : ""}${headline}. Open breakdown for all stored runs.`;

  return (
    <>
      {liveRegion}
      <Popover width={320} position="bottom-end" withArrow shadow="md" trapFocus>
        <Popover.Target>
          <UnstyledButton
            className={pillClass}
            data-spend-pill
            data-live={active ? "true" : undefined}
            aria-label={buttonLabel}
          >
            <CoinDisc />
            <span className={classes.word}>Total spend</span>
            {value !== null ? (
              // The departure board — imperative cells, hidden from AT as one blob. At rest
              // the button label + live region carry the value (and the "up to" ceiling
              // qualifier); while live the label reads "calculating". The pill face shows the
              // bare folded number in every state; the "up to" qualifier lives only in the
              // popover + accessible labels.
              <span className={classes.board} aria-hidden ref={boardRef} />
            ) : active ? (
              // Live with no known dollars yet: the unknown board ROLLS (motion texture, no
              // committed value) instead of a text "Calculating…"; static dashes under
              // reduced motion. Never a resting fake $0.
              <UnknownBoard rolling={!reduced} />
            ) : (
              <span className={classes.fallbackText}>{headline}</span>
            )}
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Text fz="sm" fw={700}>
                Total spend: {report!.totalLabel}
              </Text>
              <Group gap={6} wrap="nowrap">
                <Text fz="xs" c="dimmed">
                  Stored runs:
                </Text>
                <Badge variant="light" color="gray" size="sm" radius="xl">
                  {report!.sessionCount}
                </Badge>
              </Group>
            </Group>
            <Divider />
            <Stack gap="sm">
              {report!.rows.map((row) => (
                <div key={row.modelId}>
                  <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                      <Text fz="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
                        {row.name}
                      </Text>
                      {row.detail && (
                        <Text fz="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                          {row.detail}
                        </Text>
                      )}
                      <Text fz="xs" c="dimmed">
                        {row.imageCountKnown
                          ? `${row.images} generated image${row.images === 1 ? "" : "s"}`
                          : "Generated image count unavailable"}
                      </Text>
                    </div>
                    <Text fz="sm" fw={700} style={{ flex: "none" }}>
                      {row.label}
                    </Text>
                  </Group>
                  {row.caveats.length > 0 && (
                    <Text fz="xs" c="dimmed" mt={2} style={{ overflowWrap: "anywhere" }}>
                      {row.caveats.join(" ")}
                    </Text>
                  )}
                </div>
              ))}
            </Stack>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </>
  );
}

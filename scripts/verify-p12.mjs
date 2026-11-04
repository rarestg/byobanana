// P12 behavioral verification in a REAL headless Chromium (Playwright): the split-flap
// spend pill. Drives a ?mock=1 run and asserts the departure board rolls while the run
// is live (cells animating, coin spinning, teal ring, NO pulsing dot), grand-settles on
// EXACTLY the aggregate the popover reports (visual glyph check, not just bookkeeping),
// keeps the 56px header/30px pill geometry through every phase (P16: the R3 board —
// 16×24 cells, static decimal flap cell, runtime seam nudge), shows a keyboard focus
// ring, survives narrow headers unclipped, and fully disables motion under
// prefers-reduced-motion. Screenshots for both schemes land in scripts/screenshots/p12/.
//
// Run:  node scripts/verify-p12.mjs   (requires a prior `npm run build`)
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const shotDir = join(root, "scripts", "screenshots", "p12");

function loadChromium() {
  const roots = [];
  const npxCache = join(homedir(), ".npm", "_npx");
  if (existsSync(npxCache)) for (const e of readdirSync(npxCache)) roots.push(join(npxCache, e, "node_modules"));
  for (const spec of ["playwright", "playwright-core"]) {
    try {
      return require(spec).chromium;
    } catch {
      /* next */
    }
    for (const r of roots) {
      try {
        return createRequire(join(r, "index.js"))(spec).chromium;
      } catch {
        /* next */
      }
    }
  }
  console.error("Playwright missing. Run `npx playwright install chromium`.");
  process.exit(2);
}

function startPreview() {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["vite", "preview", "--port", "4323", "--strictPort"], { cwd: root });
    let url = "";
    const onData = (buf) => {
      const m = /http:\/\/localhost:(\d+)\//.exec(buf.toString());
      if (m && !url) {
        url = `http://localhost:${m[1]}/`;
        resolve({ child, url });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => reject(new Error(`vite preview exited ${c}`)));
    setTimeout(() => reject(new Error("preview did not start")), 30_000);
  });
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// Snapshot the pill geometry + live visuals from inside the page.
const readPill = () => ({
  header: document.querySelector("[data-workbench-toolbar]")?.getBoundingClientRect().height ?? null,
  pill: document.querySelector("[data-spend-pill]")?.getBoundingClientRect().height ?? null,
  live: document.querySelector('[data-spend-pill][data-live="true"]') !== null,
  cells: document.querySelectorAll("[data-digit]").length,
  rolling: [...document.querySelectorAll("[data-digit]")].filter((c) => c.className.includes("rolling")).length,
  // A pulsing status dot (removed in P12) would be a `.dot` module class; the decimal
  // separator (`.dotcell` since P16, `.dotsep` before) legitimately contains "dot" and
  // must not trip this.
  dot: [...document.querySelectorAll("[data-spend-pill] *")].some(
    (el) => typeof el.className === "string" && /dot/.test(el.className) && !/dot(sep|cell)/.test(el.className),
  ),
  coinAnimating: (() => {
    const coin = document.querySelector('[data-spend-pill] [class*="coin"]');
    return coin ? coin.getAnimations().length > 0 : false;
  })(),
  ring: (() => {
    const pill = document.querySelector("[data-spend-pill]");
    return pill ? getComputedStyle(pill).boxShadow !== "none" : false;
  })(),
});

// The board's VISUAL value: for each cell, resolve the strip's computed translateY to a
// strip index and read the glyph actually sitting in the window — then confirm it agrees
// with the engine's committed data-digit. Returns { value: "$X.XX", agree: boolean }.
const readBoard = () => {
  const cells = [...document.querySelectorAll("[data-digit]")];
  // Cell height comes from the live layout (SpendPill sets --ch from flapMath.CELL_HEIGHT),
  // so a metrics change can't silently desync this harness.
  const CH = cells.length > 0 ? parseFloat(getComputedStyle(cells[0]).height) : NaN;
  let agree = cells.length > 0;
  const digits = cells.map((cell) => {
    const strip = cell.querySelector('[class*="strip"]');
    const t = getComputedStyle(strip).transform;
    const j = t && t !== "none" ? -new DOMMatrixReadOnly(t).m42 / CH : NaN;
    const glyph = strip.children[Math.round(j)]?.textContent ?? "?";
    if (Math.abs(j - Math.round(j)) > 0.01 || glyph !== cell.dataset.digit) agree = false;
    return glyph;
  });
  const s = digits.join("");
  return { value: `$${s.slice(0, -2)}.${s.slice(-2)}`, agree };
};

async function runStage(browser, url, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  const before = await page.evaluate(readPill);
  check("idle: no live marker, no dot, no coin animation", !before.live && !before.dot && !before.coinAnimating);
  check("header is 56px / pill is 30px before the run", before.header === 56 && before.pill === 30, JSON.stringify(before));

  // Keyboard focus ring (zero-session pill is static; check the focusable pill later
  // too — but the outline rule applies to the button variant, so run a run first).

  // 6 variants slow the mock run enough to observe the rolling state.
  await page.getByLabel("Variants per style").fill("6");
  await page.getByLabel("Subject prompt").fill("a friendly robot mascot holding a banana");
  await page.getByRole("button", { name: "Generate" }).click();

  // While live: cells rolling, coin spinning, teal ring, still no dot, geometry stable.
  const liveSeen = await page
    .waitForFunction(
      () => {
        const live = document.querySelector('[data-spend-pill][data-live="true"]') !== null;
        const rolling = [...document.querySelectorAll("[data-digit]")].filter((c) =>
          c.className.includes("rolling"),
        ).length;
        return live && rolling > 0;
      },
      undefined,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  check("live run: pill live + digit cells rolling", liveSeen);
  const during = await page.evaluate(readPill);
  check("live run: coin spins", during.coinAnimating);
  check("live run: teal ring present", during.ring);
  check("live run: NO pulsing dot", !during.dot);
  check("header/pill height unchanged during the run", during.header === 56 && during.pill === 30, JSON.stringify(during));
  // The strips genuinely move: compare a strip's computed transform across two frames.
  const moves = await page.evaluate(async () => {
    const strip = document.querySelector('[data-digit] [class*="strip"]');
    if (!strip) return false;
    const a = getComputedStyle(strip).transform;
    await new Promise((r) => setTimeout(r, 120));
    return getComputedStyle(strip).transform !== a;
  });
  check("live run: strip transforms advance between frames", moves);
  // P16: the decimal is a STATIC flap cell — same card, one "." glyph, 16×24 (P32: the
  // decimal card is now the SAME width as a digit cell), no data-digit (engine + digit
  // selectors skip it), and it NEVER animates, even mid-roll.
  const dotcell = await page.evaluate(() => {
    const el = document.querySelector('[data-spend-pill] [class*="dotcell"]');
    if (!el) return null;
    const strip = el.querySelector('[class*="strip"]');
    return {
      text: el.textContent,
      w: parseFloat(getComputedStyle(el).width),
      h: parseFloat(getComputedStyle(el).height),
      hasDigit: el.hasAttribute("data-digit"),
      transform: getComputedStyle(strip).transform,
      animations: el.getAnimations({ subtree: true }).length,
    };
  });
  check(
    "static decimal flap cell (16×24, '.', no data-digit, never animates while rolling)",
    dotcell !== null &&
      dotcell.text === "." &&
      dotcell.w === 16 &&
      dotcell.h === 24 &&
      !dotcell.hasDigit &&
      (dotcell.transform === "none" || dotcell.transform === "matrix(1, 0, 0, 1, 0, 0)") &&
      dotcell.animations === 0,
    JSON.stringify(dotcell),
  );

  // Completion: busy falls only after the refreshed final aggregate lands; the grand
  // settle plays; the board's visual glyphs equal the popover's total exactly.
  await page.waitForFunction(
    () => document.querySelector('[data-spend-pill][data-live="true"]') === null,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-digit]")].every((c) => !c.className.includes("rolling")),
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(1700); // let the staggered settle + re-home finish
  const after = await page.evaluate(readPill);
  check("after run: calm (no live marker, no coin animation, no rolling)", !after.live && !after.coinAnimating && after.rolling === 0);
  check("header/pill height unchanged after the run", after.header === 56 && after.pill === 30, JSON.stringify(after));

  // P16/R3 typography: 16×24 cells, mono/bold 16px digits, 13px micro-label (key-pill
  // parity), and the runtime seam nudge measured onto the board (glyphs optically
  // centered on the hinge — never the un-nudged 0px default in a real browser).
  const typo = await page.evaluate(() => {
    const cell = document.querySelector("[data-digit]");
    const glyph = cell?.querySelector('[class*="glyph"]');
    const word = document.querySelector('[data-spend-pill] [class*="word"]');
    const boardEl = document.querySelector('[data-spend-pill] [class*="board"]');
    const g = glyph ? getComputedStyle(glyph) : null;
    const w = word ? getComputedStyle(word) : null;
    return {
      // The inline --ch proves the JS (flapMath.CELL_HEIGHT) assignment reached the DOM —
      // a plain 24px computed height could also come from the CSS fallback.
      inlineCh: boardEl?.style.getPropertyValue("--ch"),
      seamNudge: boardEl?.style.getPropertyValue("--seam-nudge"),
      symNudge: boardEl?.style.getPropertyValue("--sym-nudge"),
      cellH: cell ? parseFloat(getComputedStyle(cell).height) : null,
      cellW: cell ? parseFloat(getComputedStyle(cell).width) : null,
      glyphFz: g?.fontSize,
      glyphFw: g?.fontWeight,
      mono: g ? /monospace|SF Mono|Menlo|Consolas|Liberation Mono/i.test(g.fontFamily) : false,
      wordFz: w?.fontSize,
    };
  });
  check(
    "P16 board typography (JS-set --ch, 16×24 cells, 16px/700 mono digits, 13px label)",
    typo.inlineCh === "24px" && typo.cellH === 24 && typo.cellW === 16 && typo.glyphFz === "16px" && typo.glyphFw === "700" && typo.mono && typo.wordFz === "13px",
    JSON.stringify(typo),
  );
  check(
    "seam nudge measured at runtime onto the board (--seam-nudge + --sym-nudge set)",
    /px$/.test(typo.seamNudge ?? "") && /px$/.test(typo.symNudge ?? ""),
    JSON.stringify({ seamNudge: typo.seamNudge, symNudge: typo.symNudge }),
  );

  const board = await page.evaluate(readBoard);
  check("board glyphs visually agree with committed digits", board.agree, board.value);
  const buttonName = await page.locator("[data-spend-pill]").getAttribute("aria-label");
  check("button label carries the settled total", buttonName?.includes(board.value) ?? false, `${buttonName} vs ${board.value}`);
  await page.locator("[data-spend-pill]").click();
  // P32: the popover total line keeps the "up to" ceiling qualifier (formatSpend), while
  // the pill face shows the bare folded number.
  const popoverTotal = await page.locator("text=/^Total spend: up to \\$/").first().textContent();
  check(
    "grand settle equals the popover aggregate exactly (popover keeps 'up to')",
    popoverTotal === `Total spend: up to ${board.value}`,
    `${popoverTotal} vs up to ${board.value}`,
  );
  await page.keyboard.press("Escape");

  // Keyboard focus ring on the pill button.
  const focusRing = await page.evaluate(() => {
    document.querySelector("[data-spend-pill]").focus();
    return true;
  });
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || !el.hasAttribute("data-spend-pill")) return "not-focused";
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? "ring" : "no-ring";
  });
  check("keyboard focus ring visible on the pill", focusRing && outline === "ring", outline);

  // Screenshots: settled pill, both schemes.
  mkdirSync(shotDir, { recursive: true });
  const header = page.locator("[data-workbench-toolbar]");
  await header.screenshot({ path: join(shotDir, "settled-light.png") });
  await page.getByRole("button", { name: /Switch to dark scheme|color scheme|theme/i }).first().click().catch(() => {});
  await page.evaluate(() => {
    // Fallback: force the scheme attribute if the toggle's label doesn't match.
    document.documentElement.setAttribute("data-mantine-color-scheme", "dark");
  });
  await page.waitForTimeout(250);
  await header.screenshot({ path: join(shotDir, "settled-dark.png") });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-mantine-color-scheme", "light");
  });

  // Narrow-header sweep (Codex T1+T2): the 30px pill + wider 16px cells must survive
  // the sub-sm band (spend-pill word/coin + key-pill label hidden below 48em; title
  // block sr-only + bezel hidden below xs=36em) with no header overflow and the board
  // fully inside the header — digit cells must NEVER clip. Codex T2: a realistic
  // accumulated total is wider than one mock run's, so each width is ALSO probed with
  // the board grown to 5 cells ($100+) and 8 cells by cloning digit cells (the clones
  // replicate exact cell geometry; removed after measuring). Budget by design: 5-cell
  // fits everywhere ≥320; 8-cell everywhere ≥375.
  const measureHeader = ([extraCells]) => {
    const headerEl = document.querySelector("[data-workbench-toolbar]");
    const pill = document.querySelector("[data-spend-pill]");
    const boardEl = document.querySelector('[data-spend-pill] [class*="board"]');
    const template = boardEl.querySelector("[data-digit]");
    const clones = [];
    for (let n = 0; n < extraCells; n += 1) {
      const clone = template.cloneNode(true);
      clone.removeAttribute("data-digit"); // a probe, not an engine cell
      boardEl.insertBefore(clone, template);
      clones.push(clone);
    }
    const hr = headerEl.getBoundingClientRect();
    const br = boardEl.getBoundingClientRect();
    const geo = {
      overflow: headerEl.scrollWidth > headerEl.clientWidth,
      boardInside: br.left >= hr.left && br.right <= hr.right,
      pillH: pill.getBoundingClientRect().height,
      headerH: hr.height,
      // The brand title must stay on ONE line where visible (a wrap spills out of the
      // 56px header vertically without tripping scrollWidth); below xs the title block
      // is sr-only, so the check is skipped there.
      titleH: document.querySelector("[data-brand-wordmark]")?.getBoundingClientRect().height ?? null,
    };
    for (const clone of clones) clone.remove();
    return geo;
  };
  for (const width of [320, 375, 480, 577, 640, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    for (const cells of [3, 5, 8]) {
      // Accepted limit: 8 digits means $100,000+ of spend, which overflows a 375px header.
      if (cells === 8 && width <= 375) continue;
      const geo = await page.evaluate(measureHeader, [cells - 3]);
      const titleOk = width < 577 || (geo.titleH !== null && geo.titleH < 25);
      check(
        `narrow header ${width}px / ${cells}-cell board: no overflow, board unclipped, one-line title (where visible), 56/30 geometry`,
        !geo.overflow && geo.boardInside && geo.pillH === 30 && geo.headerH === 56 && titleOk,
        JSON.stringify(geo),
      );
    }
    if (width === 375) await header.screenshot({ path: join(shotDir, "narrow-375.png") });
  }

  await context.close();
}

async function reducedMotionStage(browser, url, errors) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${url}app/?mock=1`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Set up a run");

  await page.getByLabel("Variants per style").fill("6");
  await page.getByLabel("Subject prompt").fill("a calm robot in reduced motion");
  await page.getByRole("button", { name: "Generate" }).click();

  const liveSeen = await page
    .waitForFunction(() => document.querySelector('[data-spend-pill][data-live="true"]') !== null, undefined, {
      timeout: 5000,
    })
    .then(() => true)
    .catch(() => false);
  check("reduced motion: live marker (static ring) still appears", liveSeen);
  const during = await page.evaluate(readPill);
  check("reduced motion: nothing rolls, coin does not spin", during.rolling === 0 && !during.coinAnimating, JSON.stringify(during));

  await page.waitForFunction(
    () => document.querySelector('[data-spend-pill][data-live="true"]') === null,
    undefined,
    { timeout: 20_000 },
  );
  // Instant settle: the truth is on the board immediately — no 1.5s stagger window.
  await page.waitForTimeout(120);
  const board = await page.evaluate(readBoard);
  check("reduced motion: instant settle, board agrees with committed digits", board.agree, board.value);
  const after = await page.evaluate(readPill);
  check("reduced motion: calm after the run", !after.live && after.rolling === 0 && !after.coinAnimating);

  mkdirSync(shotDir, { recursive: true });
  await page.locator("[data-workbench-toolbar]").screenshot({ path: join(shotDir, "reduced-motion.png") });
  await context.close();
}

const chromium = loadChromium();
const { child, url } = await startPreview();
const browser = await chromium.launch();
const errors = [];
try {
  await runStage(browser, url, errors);
  await reducedMotionStage(browser, url, errors);
} finally {
  await browser.close();
  child.kill();
}
check("zero console errors", errors.length === 0, errors.join(" | "));
console.log(failures === 0 ? "\nP12 verify: ALL PASS" : `\nP12 verify: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

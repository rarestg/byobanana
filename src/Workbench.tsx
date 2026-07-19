import {
  Box,
  Burger,
  Collapse,
  Drawer,
  Group,
  Loader,
  Stack,
  Text,
  Alert,
  Badge,
  VisuallyHidden,
  useMatches,
} from "@mantine/core";
import { useDisclosure, useReducedMotion } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useRef, useState } from "react";

import bananaIcon from "./assets/banana-icon.svg";
import { generateImage } from "./core/gemini";
import { IdbSessionRepository, type StorageError } from "./core/idbRepository";
import {
  type CreateSessionInput,
  type SessionManifest,
  type SessionRepository,
  type SessionSummary,
} from "./core/session";
import { sessionsChannel } from "./core/sessionsChannel";
import { KeyStatusPill } from "./KeyPanel";
import { OnboardingBanner } from "./OnboardingBanner";
import { HistoryRail } from "./run/HistoryRail";
import { RunQueue, type GenerationRunner, type RunUpdate } from "./run/queue";
import { mockFailRunner, mockRunner } from "./run/mockRunner";
import { RunSummary } from "./run/RunSummary";
import { SessionView } from "./run/SessionView";
import { SpendPill } from "./run/SpendPill";
import { buildSetupSeed, type SetupFormSeed } from "./setup/editSeed";
import { SetupForm } from "./setup/SetupForm";
import { ThemeToggle } from "./ThemeToggle";
import { STORAGE_KEY, useApiKey } from "./useApiKey";
import { useSingleTab } from "./useSingleTab";
import classes from "./Workbench.module.css";

// The onboarding banner's lifecycle: visible until the key validates, then it flies toward
// the header key pill ("flying"), the vacated height collapses ("closing"), and it's gone.
type BannerPhase = "visible" | "flying" | "closing" | "hidden";

function readStoredKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

// Test/harness-only mock gate: `?mock=1` runs generations through the local mock runner with
// no key (and suppresses the onboarding banner). P15: `?mock=fail` is the same gate but every
// second candidate fails as a mock content-policy block, so the failure UI (card tag +
// inspector Failure detail) can be exercised in a real browser. Deliberately invisible to
// users — the user-facing mock toggle was removed in P8.
function readMockParam(): "off" | "on" | "fail" {
  try {
    const value = new URLSearchParams(window.location.search).get("mock");
    return value === "1" ? "on" : value === "fail" ? "fail" : "off";
  } catch {
    return "off";
  }
}

// The workbench. P17 embeds it in the static BYOBanana landing document: instead of owning the
// viewport via a Mantine AppShell, it renders an in-flow sticky toolbar + a history Drawer inside
// the landing page's #generator section. P6 makes persistence durable: the repository is the
// IndexedDB adapter (opened + interrupted-run-recovered on boot), a Drawer hosts the history rail,
// the toolbar pill shows cross-session spend, and the terminal-recovery seam becomes full
// edit-and-regenerate with reference inheritance. The queue + views consume the UNCHANGED
// SessionRepository interface.
export interface WorkbenchProps {
  // Test seam: inject a ready repository so component tests avoid IndexedDB (fake-indexeddb
  // cannot round-trip jsdom Blobs). Default opens the durable IndexedDB adapter and runs
  // interrupted-run recovery before the first render.
  repository?: SessionRepository;
}

export function Workbench({ repository }: WorkbenchProps = {}) {
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  // True while the history Drawer's nested "Clear history" confirmation Modal is open — the
  // Drawer suspends its own Escape/click-outside dismissal then, so one Escape closes only the
  // Modal (not the Modal AND the Drawer beneath it).
  const [historyConfirmOpen, setHistoryConfirmOpen] = useState(false);
  // P14 header/content alignment: the burger is rail furniture; the brand block then
  // sits one full content gutter after it — the same 2×md rhythm the workspace uses
  // below (AppShell padding md + the .sheet's md inset = the cards' 32px left gutter).
  // Width-tight headers keep the old compact "sm" gap.
  const headerGap = useMatches({ base: "sm", sm: "calc(2 * var(--mantine-spacing-md))" });
  const { ready, apiKey, status } = useApiKey();
  // Single-tab guard: only the PRIMARY tab recovers interrupted runs and generates. A SECONDARY
  // tab (opened while another holds the lock) views history read-only so it can't corrupt a live
  // run. "pending" while the lock is being acquired; browsers without Web Locks resolve primary.
  // The guard protects the durable IndexedDB path, so an INJECTED repository (test seam / future
  // adapter) is always treated as primary — no cross-context lock coordination applies there.
  const tabRole = useSingleTab();
  const effectiveRole = repository ? "primary" : tabRole;
  const secondary = effectiveRole === "secondary";

  // Harness-only mock gate (see readMockParam). Lazy state: read once per mount so tests can
  // set the URL before render; never re-read mid-session.
  const [mockParam] = useState(readMockParam);
  const mockEnabled = mockParam !== "off";

  // ---- Onboarding banner state machine (P8) -------------------------------------------
  // A remembered key boots as "unvalidated" and auto-validates (useApiKey), so the banner
  // starts hidden for returning users and only re-appears if that validation FAILS. First
  // visits (no stored key) start visible. `?mock=1` suppresses it entirely.
  const reduceMotion = useReducedMotion();
  const [bootKey] = useState(readStoredKey);
  const [banner, setBanner] = useState<BannerPhase>(() =>
    mockEnabled || bootKey ? "hidden" : "visible",
  );
  const [pillFlash, setPillFlash] = useState(false);
  const bannerBoxRef = useRef<HTMLDivElement>(null);
  const formBoxRef = useRef<HTMLDivElement>(null);
  // Whether focus was inside the banner when it dismissed — if so, hand focus to the pill.
  const focusPillRef = useRef(false);
  // "Boot grace": while the remembered key's auto-validation is in flight the banner stays
  // hidden. Grace ends the moment status leaves that boot pipeline (validating counts as
  // in-pipeline) — including a user edit — and NEVER comes back, so retyping the exact boot
  // key later can't silently suppress the banner again.
  const bootGraceRef = useRef(Boolean(bootKey));
  useEffect(() => {
    if (!bootGraceRef.current) return;
    const inBootPipeline =
      status.state === "validating" ||
      (status.state === "unvalidated" && status.key === bootKey);
    if (!inBootPipeline) bootGraceRef.current = false;
  }, [status, bootKey]);

  // Re-show the banner whenever there is genuinely no usable key: cleared ("empty"), failed
  // validation ("invalid"), or an unvalidated key outside the boot grace window. If focus
  // was inside the form (about to become inert), hand it to the banner's key input.
  useEffect(() => {
    if (mockEnabled || ready || banner !== "hidden") return;
    if (
      status.state === "empty" ||
      status.state === "invalid" ||
      (status.state === "unvalidated" && !bootGraceRef.current)
    ) {
      const focusWasInForm = formBoxRef.current?.contains(document.activeElement) ?? false;
      setBanner("visible");
      if (focusWasInForm) {
        requestAnimationFrame(() => document.getElementById("nb-onboarding-key")?.focus());
      }
    }
  }, [mockEnabled, ready, banner, status]);

  // Key validated while the banner is up: fly it toward the pill (or, with reduced motion,
  // swap instantly) and then flash the pill — "key management lives here now".
  useEffect(() => {
    if (!ready || banner !== "visible") return;
    focusPillRef.current = bannerBoxRef.current?.contains(document.activeElement) ?? false;
    if (reduceMotion) {
      setBanner("hidden");
      setPillFlash(true);
    } else {
      setBanner("flying");
    }
  }, [ready, banner, reduceMotion]);

  // Fly (content shrinks toward the pill) → close (Collapse animates the height away) → gone.
  // If the key stops being valid MID-dismissal (cleared/edited during the animation), abort
  // back to visible — never a success flash/announcement without a valid key.
  useEffect(() => {
    if (banner !== "flying" && banner !== "closing") return;
    if (!ready) {
      setBanner("visible");
      return;
    }
    if (banner === "flying") {
      const timer = setTimeout(() => setBanner("closing"), 430);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      setBanner("hidden");
      setPillFlash(true);
    }, 240);
    return () => clearTimeout(timer);
  }, [banner, ready]);

  useEffect(() => {
    if (!pillFlash) return;
    if (focusPillRef.current) {
      focusPillRef.current = false;
      document.getElementById("nb-key-pill")?.focus();
    }
    const timer = setTimeout(() => setPillFlash(false), 1800);
    return () => clearTimeout(timer);
  }, [pillFlash]);
  // --------------------------------------------------------------------------------------

  // Async boot: the durable repo is available only after the DB opens + recovery runs.
  const [repo, setRepo] = useState<SessionRepository | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const repoRef = useRef<SessionRepository | null>(null);

  // The history rail's session list (cross-session spend derives from it too).
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  // The viewed run: the live/loaded manifest + any run-level fatal error, and whether the setup
  // form is collapsed into the run summary.
  const [runState, setRunState] = useState<RunUpdate | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // True while a generation queue is in flight (guards Clear history; drives no UI beyond that).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  // Mirror the secondary-tab flag into a ref so the empty-dep handleClear reads the latest value.
  const secondaryRef = useRef(secondary);
  secondaryRef.current = secondary;
  // "Edit and regenerate" seed handed to the (kept-mounted) SetupForm.
  const [seed, setSeed] = useState<SetupFormSeed | undefined>(undefined);

  const queueRef = useRef<RunQueue | null>(null);
  // The VIEWED session id — gates which manifest updates reach the results view. A background
  // queue for a different (previously started) session keeps running and refreshing history, but
  // its updates never clobber the session the user is currently looking at.
  const activeSessionRef = useRef<string | null>(null);
  // ONE monotonic view-intent counter shared by every async operation that changes what the
  // results view shows — history load, edit-and-regenerate seed build, submit, and clear. Each
  // op captures the value and re-checks it before applying its result, so a slow op can never
  // overwrite a newer navigation (source historyLoadIntent, generalized).
  const viewIntent = useRef(0);
  // A submission generation for the busy flag: only the LATEST submission's idle callback may
  // clear busy, so a superseded run reaching idle can't unblock Clear during a new run's setup.
  const submitGen = useRef(0);

  // Coalesced history refresh: collapse a burst of queue updates into at most one in-flight
  // listSessions + one trailing re-list, so rapid candidate completions don't stampede the DB.
  // P12: returns a SHARED drain promise that resolves only after the requested + trailing
  // refresh loop fully drains — the run-completion path awaits it before clearing `busy`, so
  // the spend pill's falling edge always settles on the final aggregate, never a stale
  // partial (with the old fire-and-forget coalescer, an in-flight refresh made even
  // `await refreshHistory()` resolve before the trailing re-list ran).
  const refreshRunRef = useRef<Promise<void> | null>(null);
  const refreshAgainRef = useRef(false);
  const refreshHistory = useCallback((): Promise<void> => {
    if (!repoRef.current) return Promise.resolve();
    if (refreshRunRef.current) {
      // A refresh is in flight: request a trailing re-list and share its drain promise.
      refreshAgainRef.current = true;
      return refreshRunRef.current;
    }
    // Definite-assignment assertion: the microtask barrier below guarantees nothing
    // in the body (returns, sync throws, the finally) can run before `run` is assigned.
    let run!: Promise<void>;
    run = (async () => {
      // Suspend immediately so the whole body — including a repository whose
      // listSessions throws synchronously — executes after `run` is assigned; the
      // finally can then never observe it in its temporal dead zone (which would
      // strand a resolved promise in the slot forever).
      await Promise.resolve();
      try {
        do {
          refreshAgainRef.current = false;
          // Re-read the repo each iteration so a swapped/closed repository is never
          // asked for a stale snapshot mid-drain…
          const active = repoRef.current;
          if (!active) return;
          try {
            const listed = await active.listSessions();
            // …and never allowed to PUBLISH one: a swap while the read was pending
            // means the new repository's own boot listing is the truth now.
            if (repoRef.current !== active) return;
            setSessions(listed);
          } catch {
            // A transient read failure must not break the rail; the next update retries.
          }
        } while (refreshAgainRef.current);
      } finally {
        // Identity-guarded: only THIS run may clear the slot (synchronous with the
        // final drain check — no new request can interleave before it).
        if (refreshRunRef.current === run) refreshRunRef.current = null;
      }
    })();
    refreshRunRef.current = run;
    return run;
  }, []);

  // Auto-refresh the rail (P10): replaces the removed manual refresh button. Re-list on window
  // focus and on visibilitychange-to-visible (catches another tab's writes made while this tab
  // was hidden), and on a same-origin BroadcastChannel "sessions-changed" ping posted by the
  // repository right after createSession/startCandidate/writeCandidateResult/recordExport/
  // clear/recover commit (catches them while visible, without waiting for a focus change).
  // refreshHistory itself is a no-op until repo is open.
  useEffect(() => {
    const onWake = () => void refreshHistory();
    const onVisibility = () => {
      if (document.visibilityState === "visible") onWake();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onVisibility);
    const onChannelMessage = (event: MessageEvent) => {
      if (event.data?.type === "sessions-changed") void refreshHistory();
    };
    sessionsChannel?.addEventListener("message", onChannelMessage);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onVisibility);
      sessionsChannel?.removeEventListener("message", onChannelMessage);
    };
  }, [refreshHistory]);

  // Open the repository and recover any interrupted run before first render. StrictMode-safe by
  // construction: each effect run owns a `cancelled` flag; a discarded run (double-mount) closes
  // its own connection and never sets state, while the surviving run opens its own and wins.
  // recover() is idempotent, so running it on a discarded connection is harmless.
  useEffect(() => {
    // Wait until the single-tab role is decided before touching storage: recovery is a WRITE
    // that only the primary tab may perform.
    if (effectiveRole === "pending") return;
    let cancelled = false;
    (async () => {
      try {
        let active = repository;
        if (!active) {
          const idb = await IdbSessionRepository.open({
            onWriteError: (error: StorageError) =>
              notifications.show({
                color: "red",
                title: error.quotaExceeded ? "Local storage is full" : "Storage error",
                message: error.message,
              }),
          });
          // Only the primary tab recovers interrupted runs; a secondary tab skips it so it can't
          // flip another tab's live "running" candidates to "interrupted".
          if (effectiveRole === "primary") await idb.recover();
          if (cancelled) {
            idb.close();
            return;
          }
          active = idb;
        }
        if (cancelled) return;
        repoRef.current = active;
        setRepo(active);
        setSessions(await active.listSessions());
      } catch (error) {
        if (!cancelled) {
          setInitError(error instanceof Error ? error.message : "Could not open local storage.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repository, effectiveRole]);

  const handleSubmit = useCallback(
    async (input: CreateSessionInput) => {
      const active = repoRef.current;
      if (!active) return;
      // A secondary tab must not write: generating here would race the primary tab's storage.
      if (secondary) {
        notifications.show({
          color: "yellow",
          title: "Open in another tab",
          message: "BYOBanana runs in one tab at a time. To generate here, close the other tab, then reload this one.",
        });
        return;
      }
      // The harness mock gate always wins (even over a validated key — ?mock=1 must never
      // spend real money); otherwise a validated key is REQUIRED (Generate is gated on it,
      // but double-guard the billing path here).
      const useMock = mockEnabled;
      if (!useMock && !ready) return;

      // Real key: warn (don't block) if the chosen model isn't currently visible to the key.
      if (!useMock && status.state === "valid") {
        const visible = status.availableModels;
        if (visible.length > 0 && !visible.includes(input.settings.modelId)) {
          notifications.show({
            color: "yellow",
            title: "Model may be unavailable",
            message: `Your key can't currently see ${input.settings.modelId}. If generation fails, pick a visible model and regenerate.`,
          });
        }
      }

      // A new submission supersedes any pending view navigation (history load / seed build).
      // Capture its intent so that if a NEWER navigation completes while this run is being
      // assembled (createSession hashes/awaits), we still start the run in the background but do
      // NOT yank the view away from what the user has since navigated to.
      const intent = ++viewIntent.current;
      const gen = ++submitGen.current;
      // Mark busy BEFORE any awaited work (cancel/hashing/createSession) so Clear history is
      // blocked for the whole run assembly, not just once the queue is pumping.
      setBusy(true);
      try {
        // Abandon any previous run fully (drop pending + abort in-flight, then wait for it to go
        // idle) so it can't keep updating state or launch more billing under the new run.
        await queueRef.current?.cancel();
        await queueRef.current?.waitForIdle();

        const manifest = await active.createSession(input);
        // If a newer navigation won during createSession, leave the view where the user put it;
        // the run still starts (below) and stays visible in the history rail via refreshHistory.
        const showInView = viewIntent.current === intent;
        if (showInView) activeSessionRef.current = manifest.id;

        const runner: GenerationRunner = useMock
          ? (mockParam === "fail" ? mockFailRunner : mockRunner)
          : (request, signal) => generateImage(request, { apiKey: apiKey!, signal, timeoutMs: 120_000 });

        const queue = new RunQueue({
          repo: active,
          sessionId: manifest.id,
          runner,
          apiKey: useMock ? undefined : apiKey,
          // P16: user-configured parallelism (SetupForm "Parallel requests", 1–24; the
          // ?? covers manifests created before the setting existed).
          concurrency: manifest.settings.parallelRequests ?? 4,
          onUpdate: (update) => {
            // Every update refreshes the rail (live spend + status), regardless of what is viewed.
            void refreshHistory();
            // Only apply to the results view if it's the session currently being looked at.
            if (update.manifest.id !== activeSessionRef.current) return;
            setRunState(update);
          },
        });
        queueRef.current = queue;

        if (showInView) {
          setRunState({ manifest });
          setCollapsed(true);
        }
        await queue.start();
        void refreshHistory();
        // Clear busy only when THIS submission reaches idle — a superseded run's callback (gen no
        // longer current) must not unblock Clear during a newer run's setup. P12: drain the
        // (coalesced) history refresh FIRST, so the sessions state already carries the final
        // aggregate when `busy` falls — the spend pill settles on the confirmed total.
        void queue.waitForIdle().then(async () => {
          try {
            await refreshHistory();
          } catch {
            // Drain failure: sessions stay stale until the next refresh retries.
          } finally {
            // Never strand busy=true, even if the drain itself rejects.
            if (submitGen.current === gen) setBusy(false);
          }
        });
      } catch (error) {
        // createSession/start can reject (e.g. storage quota). Don't strand busy=true; surface
        // it to the SetupForm's inline error path. Gen-guarded like the idle callback: a
        // SUPERSEDED submission's failure must not calm the newer submission's busy state.
        if (submitGen.current === gen) setBusy(false);
        throw error;
      }
    },
    [mockParam, mockEnabled, ready, apiKey, status, refreshHistory, secondary],
  );

  const handleCancel = useCallback(() => {
    void queueRef.current?.cancel();
  }, []);

  // A manifest mutation from the inspector (Primary selection / export). The repo's stored
  // manifest was already updated; this re-renders the view and refreshes the rail's spend/status.
  const handleManifestChange = useCallback(
    (manifest: SessionManifest) => {
      if (manifest.id !== activeSessionRef.current) return;
      setRunState((prev) => (prev ? { ...prev, manifest } : { manifest }));
      void refreshHistory();
    },
    [refreshHistory],
  );

  // Load a stored session into the results view (history click). Does NOT cancel a running
  // queue — a live billing run keeps going and stays visible in the rail; its updates just stop
  // reaching this view (activeSessionRef now points at the loaded session).
  const loadSession = useCallback(
    async (id: string) => {
      const active = repoRef.current;
      if (!active) return;
      const intent = ++viewIntent.current;
      const manifest = await active.getSession(id);
      if (intent !== viewIntent.current) return; // a newer navigation won
      if (!manifest) {
        void refreshHistory();
        return;
      }
      activeSessionRef.current = id;
      setRunState({ manifest });
      setCollapsed(true);
      closeNav();
    },
    [refreshHistory, closeNav],
  );

  // "Edit and regenerate": seed the setup form from the viewed session — subject, recipes,
  // palette, settings, AND references rehydrated from the stored blobs (reference inheritance).
  const handleEditRegenerate = useCallback(async () => {
    const active = repoRef.current;
    const manifest = runState?.manifest;
    if (!active || !manifest) return;
    const intent = ++viewIntent.current;
    let nextSeed: SetupFormSeed;
    try {
      nextSeed = await buildSetupSeed(manifest, active);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Cannot edit and regenerate",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    // A newer navigation (history load / submit / clear / another edit) started while blobs
    // loaded: discard this stale seed and revoke its object URLs so it neither applies nor leaks.
    if (intent !== viewIntent.current) {
      for (const reference of nextSeed.references) URL.revokeObjectURL(reference.url);
      return;
    }
    // Replace any still-unapplied prior seed, revoking its URLs first.
    setSeed((prev) => {
      if (prev) for (const reference of prev.references) URL.revokeObjectURL(reference.url);
      return nextSeed;
    });
    setCollapsed(false);
  }, [runState]);

  // The SetupForm has consumed the seed into its own references state — drop our copy so the
  // (potentially large) reference Files aren't retained twice.
  const handleSeedApplied = useCallback(() => setSeed(undefined), []);

  const handleClear = useCallback(async () => {
    const active = repoRef.current;
    // A secondary tab is view-only; the button is disabled, but double-guard the destructive write.
    if (!active || busyRef.current || secondaryRef.current) return;
    // Supersede any pending view navigation (a history load / seed build in flight must not apply
    // after the store is wiped).
    viewIntent.current++;
    try {
      await active.clear();
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Could not clear history",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    await queueRef.current?.cancel();
    queueRef.current = null;
    activeSessionRef.current = null;
    setRunState(null);
    setCollapsed(false);
    setSeed(undefined);
    setBusy(false);
    setSessions([]);
  }, []);

  const running = runState !== null;

  // The sticky toolbar renders in EVERY state (loading / error / ready) so that when the
  // repository finishes opening, the toolbar's later population never shifts the layout. It is
  // exactly 56px tall (Workbench.module.css) — the sticky inspector in SessionView.module.css
  // offsets by that height, so keep the two in lock-step.
  const toolbar = (
    <div className={classes.toolbar} data-workbench-toolbar>
      <Group h="100%" px="md" justify="space-between" wrap="nowrap">
        {/* P14: the burger→brand gap reuses the workspace's 32px content-gutter rhythm
            (see headerGap above); the mark and title keep their own tighter "sm"
            rhythm. Below the sm breakpoint the toolbar is width-tight — fall back to
            "sm" (useMatches: Group's gap prop is not responsive). */}
        <Group gap={headerGap} wrap="nowrap">
          <Box pos="relative" style={{ flex: "none" }}>
            <Burger
              opened={navOpened}
              onClick={toggleNav}
              size="sm"
              aria-label={
                sessions.length > 0
                  ? `History, ${sessions.length} run${sessions.length === 1 ? "" : "s"}`
                  : "History"
              }
              aria-haspopup="dialog"
              aria-expanded={navOpened}
              // The Drawer that hosts #history-navbar is only mounted while open, so only
              // reference it then (a dangling aria-controls target is an a11y smell).
              aria-controls={navOpened ? "history-navbar" : undefined}
            />
            {sessions.length > 0 && (
              // Stored-run count bubble; the count is carried to AT via the burger label.
              <Badge
                variant="filled"
                size="xs"
                radius="xl"
                aria-hidden
                style={{
                  position: "absolute",
                  top: -5,
                  right: -8,
                  padding: "0 5px",
                  pointerEvents: "none",
                }}
              >
                {sessions.length > 99 ? "99+" : sessions.length}
              </Badge>
            )}
          </Box>
          {/* Brand lockup + specimen tag mirror the static header's .byo-brand-stack (index.html):
              the brand link, then a quiet mono tag held apart by a hairline divider, hidden below
              1400px (.brandTag media query). The 14px gap matches the landing's stack gap so the
              tag lands at the same x on both headers. The tag is a sibling of the <a>, never inside
              it, so it stays out of the brand's accessible name ("BYOBanana home"). */}
          <Group gap="14px" wrap="nowrap">
            {/* Brand mark links back to the landing document (/). The mark itself is decorative
                (aria-hidden); the aria-label names the link, so the accessible name is "BYOBanana
                home". The /app document carries its own visually-hidden <h1> (app/index.html), so
                the wordmark stays a <p>, not a heading. Embossed treatment in Workbench.module.css. */}
            <Group
              gap="sm"
              wrap="nowrap"
              renderRoot={(props) => <a href="/" aria-label="BYOBanana home" {...props} />}
              className={classes.brandLink}
            >
              <span className={classes.brandMark} aria-hidden>
                <span className={classes.brandBezel}>
                  <img src={bananaIcon} alt="" className={classes.brandBanana} />
                </span>
              </span>
              {/* P16: sr-only below 30em (see .titleBlock) — the banana mark carries the
                  brand on phone-tight headers; the wordmark stays in the DOM for AT. */}
              <Box className={classes.titleBlock}>
                <Text component="p" fz="h4" fw={700} lh={1} data-brand-wordmark>
                  BYOBanana
                </Text>
              </Box>
            </Group>
            <Text component="span" className={classes.brandTag}>
              No credits. No subscription.
            </Text>
          </Group>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <KeyStatusPill flash={pillFlash} />
          <SpendPill sessions={sessions} active={busy} />
          <ThemeToggle />
        </Group>
        <VisuallyHidden aria-live="polite">
          {pillFlash ? "API key validated. Manage your key from the pill in the toolbar." : ""}
        </VisuallyHidden>
      </Group>
    </div>
  );

  // History rail moves from the AppShell.Navbar into an overlay Drawer. navOpened/closeNav are
  // unchanged; the labeled <nav id="history-navbar"> keeps the landmark AppShell.Navbar gave it
  // and the selector tests query. Drawer content is unmounted while closed (Mantine default).
  const historyDrawer = (
    <Drawer
      opened={navOpened}
      onClose={closeNav}
      position="left"
      size={300}
      padding="md"
      title="History"
      closeButtonProps={{ "aria-label": "Close history" }}
      // Suspend the Drawer's own dismissal while its nested confirmation Modal is open, so the
      // Modal handles Escape / click-outside alone (see historyConfirmOpen).
      closeOnEscape={!historyConfirmOpen}
      closeOnClickOutside={!historyConfirmOpen}
      classNames={{ content: classes.drawerContent, body: classes.drawerBody }}
    >
      <nav id="history-navbar" aria-label="Run history" className={classes.drawerNav}>
        <HistoryRail
          sessions={sessions}
          currentId={activeSessionRef.current ?? undefined}
          busy={busy}
          readOnly={secondary}
          onSelect={(id) => void loadSession(id)}
          onClear={() => void handleClear()}
          onConfirmOpenChange={setHistoryConfirmOpen}
        />
      </nav>
    </Drawer>
  );

  let body;
  if (initError) {
    body = (
      <div className={`${classes.body} ${classes.bodyCenter}`}>
        <Alert color="red" variant="light" title="Storage unavailable" maw={520}>
          {initError} History and generated images can't be saved. Reload once storage is available.
        </Alert>
      </div>
    );
  } else if (!repo) {
    body = (
      <div className={`${classes.body} ${classes.bodyCenter}`}>
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed" fz="sm">
            Loading workbench…
          </Text>
        </Stack>
      </div>
    );
  } else {
    body = (
      <div className={classes.body}>
        <Stack gap="lg">
          {secondary && (
            <Alert
              color="yellow"
              variant="light"
              title="BYOBanana is open in another tab"
              maw={880}
              mx="auto"
              w="100%"
            >
              Generation runs in one tab at a time, so this tab is view-only. History is safe to
              browse here. To generate here, close the other tab, then reload this one.
            </Alert>
          )}
          {/* Onboarding banner: inline key entry until a key validates, then it flies toward
              the toolbar pill and the Collapse animates its height away. */}
          {banner !== "hidden" && (
            <div ref={bannerBoxRef}>
              <Collapse
                expanded={banner === "visible" || banner === "flying"}
                transitionDuration={reduceMotion ? 0 : 220}
              >
                <OnboardingBanner dismissing={banner === "flying" || banner === "closing"} />
              </Collapse>
            </div>
          )}

          {/* The form stays mounted so "Edit setup" restores its (uncontrolled) state; hidden
              while collapsed into the run summary. While the onboarding banner is up the form
              is window-shopping only: inert (no tab stops, no AT exposure) and dimmed. */}
          <Box
            ref={formBoxRef}
            display={running && collapsed ? "none" : undefined}
            inert={banner === "visible" && !ready ? true : undefined}
            style={
              banner === "visible" && !ready
                ? { opacity: 0.5, pointerEvents: "none" }
                : undefined
            }
          >
            <SetupForm
              onSubmit={handleSubmit}
              mockMode={mockEnabled}
              seed={seed}
              onSeedApplied={handleSeedApplied}
              generationDisabledReason={
                secondary
                  ? "This tab is view-only (open in another tab). Close the other tab, then reload this one to generate here."
                  : undefined
              }
            />
          </Box>

          {running && collapsed && runState && (
            <RunSummary manifest={runState.manifest} onEdit={() => setCollapsed(false)} />
          )}

          {running && runState && (
            <SessionView
              repo={repo}
              manifest={runState.manifest}
              fatalError={runState.fatalError}
              readOnly={secondary}
              onCancel={handleCancel}
              onManifestChange={handleManifestChange}
              onEditSetup={() => void handleEditRegenerate()}
            />
          )}
        </Stack>
      </div>
    );
  }

  return (
    <div className={classes.shell}>
      {toolbar}
      {historyDrawer}
      {body}
    </div>
  );
}

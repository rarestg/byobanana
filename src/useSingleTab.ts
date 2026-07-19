// Single-tab guard (P7). A second tab opening mid-run would re-run interrupted-run recovery
// on boot and flip the FIRST tab's still-"running" candidates to "interrupted", corrupting a
// live run. To prevent that we hold an exclusive Web Lock for the tab's lifetime: the first
// tab acquires it and becomes PRIMARY (recovers + generates); a later tab fails to acquire it
// (`ifAvailable`) and becomes SECONDARY — it skips recovery and generation, and shows a warning.
//
// Minimal by design (full multi-tab coordination is out of scope): a secondary tab does not
// live-promote when the primary closes — it must be reloaded to take over. Browsers without the
// Web Locks API fall back to PRIMARY (the pre-P7 behavior), since we can't detect a peer there.
//
// bfcache: a same-tab navigation away from /app/ (e.g. back to the landing page) does NOT tear
// the document down — Chromium can freeze it in the back/forward cache with the lock still held.
// A later /app/ load then probes a lock its own frozen predecessor holds and falsely reports
// "another tab". So we release on `pagehide` (freeing the lock before the freeze/unload) and
// re-arbitrate on `pageshow` when restored from bfcache (`persisted`), which correctly stays
// PRIMARY if the lock is free or degrades to SECONDARY if a genuine second tab took it meanwhile.

import { useEffect, useState } from "react";

const LOCK_NAME = "nano-banana-web:primary-tab";

export type TabRole = "pending" | "primary" | "secondary";

export function useSingleTab(): TabRole {
  const [role, setRole] = useState<TabRole>(() =>
    typeof navigator !== "undefined" && "locks" in navigator ? "pending" : "primary",
  );

  useEffect(() => {
    if (typeof navigator === "undefined" || !("locks" in navigator)) return;
    let unmounted = false;
    // Resolving this frees the currently-held lock; nulled after release so a double-release
    // (pagehide then React cleanup, or two pagehides) is a harmless no-op.
    let release: (() => void) | undefined;
    const releaseLock = () => {
      release?.();
      release = undefined;
    };

    // acquire() is re-callable (a bfcache-restored page re-arbitrates), so a request from a
    // superseded cycle could still resolve. `epoch` bumps per acquire; a stale callback ignores
    // its (auto-released) grant and never publishes role, so the newest cycle always wins.
    let epoch = 0;

    // Hold the lock for the tab's lifetime: the callback returns a promise that only settles
    // when we abandon it (release), so the lock is freed on release, unmount, or teardown.
    // `ifAvailable` makes a contended request resolve immediately with a null lock.
    const acquire = () => {
      const cycle = ++epoch;
      const current = () => !unmounted && cycle === epoch;
      navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!current()) return; // superseded/torn-down: drop any grant, publish nothing
          if (!lock) {
            setRole("secondary");
            return; // another tab holds it — release our (null) request and stop
          }
          setRole("primary");
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {
          if (current()) setRole("primary"); // an unexpected Locks error must not strand the app
        });
    };

    // Free the lock before the document freezes (bfcache) or unloads, so it can't leak into a
    // frozen page and block a future /app/ load in this same tab.
    const onPageHide = () => releaseLock();
    // Restored from bfcache: the frozen document dropped its lock on pagehide, so re-contend.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) acquire();
    };

    acquire();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      unmounted = true;
      releaseLock();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return role;
}

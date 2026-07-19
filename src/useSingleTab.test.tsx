// @vitest-environment jsdom
// Wiring coverage for the single-tab guard's bfcache handling. Uses a minimal navigator.locks
// stand-in (not a full Web Locks simulator): it tracks held lock names, honors `ifAvailable`,
// and frees a lock when the holder's callback promise settles — just enough to exercise
// acquire / pagehide-release / pageshow-reacquire. The stand-in resolves synchronously, so it
// does not model overlapping in-flight acquire cycles; the hook's `epoch` guard against a stale
// cycle publishing role is correct by construction (a superseded callback drops its grant and
// sets nothing) rather than covered here.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSingleTab } from "./useSingleTab";

const LOCK = "nano-banana-web:primary-tab";

type LockCallback = (lock: unknown) => unknown;

function installLocksMock() {
  const held = new Set<string>();
  const locks = {
    request(name: string, _options: unknown, callback: LockCallback): Promise<void> {
      if (held.has(name)) {
        // Contended: hand the callback a null lock (ifAvailable semantics) and settle.
        return Promise.resolve(callback(null)).then(() => {});
      }
      held.add(name);
      const result = callback({ name });
      // The holder's promise settles on release; drop the held name when it does.
      return Promise.resolve(result).then(() => {
        held.delete(name);
      });
    },
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
  return { held };
}

function firePageHide() {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

function firePageShow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  act(() => {
    window.dispatchEvent(event);
  });
}

afterEach(() => {
  delete (navigator as { locks?: unknown }).locks;
});

describe("useSingleTab", () => {
  it("acquires PRIMARY when the lock is free", async () => {
    const { held } = installLocksMock();
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("primary"));
    expect(held.has(LOCK)).toBe(true);
  });

  it("becomes SECONDARY when the lock is already held", async () => {
    const { held } = installLocksMock();
    held.add(LOCK); // another tab holds it
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("secondary"));
  });

  it("releases the lock on pagehide so a bfcache-frozen page can't retain it", async () => {
    const { held } = installLocksMock();
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("primary"));
    expect(held.has(LOCK)).toBe(true);
    firePageHide();
    await waitFor(() => expect(held.has(LOCK)).toBe(false));
  });

  it("re-acquires PRIMARY on bfcache restore when the lock is free", async () => {
    const { held } = installLocksMock();
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("primary"));
    firePageHide();
    await waitFor(() => expect(held.has(LOCK)).toBe(false));
    firePageShow(true);
    await waitFor(() => expect(held.has(LOCK)).toBe(true));
    expect(result.current).toBe("primary");
  });

  it("degrades to SECONDARY on bfcache restore if a genuine second tab took the lock", async () => {
    const { held } = installLocksMock();
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("primary"));
    firePageHide();
    await waitFor(() => expect(held.has(LOCK)).toBe(false));
    held.add(LOCK); // a real second tab grabbed the lock while this page was frozen
    firePageShow(true);
    await waitFor(() => expect(result.current).toBe("secondary"));
  });

  it("does not re-acquire on a non-persisted pageshow (a real load re-runs the effect instead)", async () => {
    const { held } = installLocksMock();
    const { result } = renderHook(() => useSingleTab());
    await waitFor(() => expect(result.current).toBe("primary"));
    firePageHide();
    await waitFor(() => expect(held.has(LOCK)).toBe(false));
    firePageShow(false);
    // No re-arbitration: the lock stays free (not re-grabbed by this hook).
    await Promise.resolve();
    expect(held.has(LOCK)).toBe(false);
  });
});

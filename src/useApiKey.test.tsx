// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gemini from "./core/gemini";
import { ApiKeyProvider, STORAGE_KEY, useApiKey } from "./useApiKey";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ApiKeyProvider>{children}</ApiKeyProvider>
);

const strictWrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <ApiKeyProvider>{children}</ApiKeyProvider>
  </StrictMode>
);

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe("useApiKey", () => {
  it("starts empty and becomes ready only after a successful validate", async () => {
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-image"],
    });
    const { result } = renderHook(() => useApiKey(), { wrapper });

    expect(result.current.ready).toBe(false);
    expect(result.current.apiKey).toBeUndefined();

    act(() => result.current.setKey("AIza-good"));
    await act(async () => {
      await result.current.validate();
    });

    expect(result.current.status.state).toBe("valid");
    expect(result.current.ready).toBe(true);
    expect(result.current.apiKey).toBe("AIza-good");
  });

  it("versioning: a stale validation for an OLD key cannot mark a NEWLY-typed key valid", async () => {
    // First validate() (key A) hangs until we release it; meanwhile the user types key B.
    let releaseA: (v: { availableModels: string[] }) => void = () => {};
    const spy = vi.spyOn(gemini, "validateApiKey").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    );

    const { result } = renderHook(() => useApiKey(), { wrapper });

    act(() => result.current.setKey("KEY-A"));
    let pendingA: Promise<void>;
    act(() => {
      pendingA = result.current.validate();
    });
    // User edits the key before A resolves — this bumps the version and aborts A.
    act(() => result.current.setKey("KEY-B"));

    // A resolves late; its result must be ignored.
    await act(async () => {
      releaseA({ availableModels: ["gemini-3.1-flash-image"] });
      await pendingA;
    });

    expect(result.current.status.state).toBe("unvalidated");
    expect(result.current.ready).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("remember persists the key to localStorage; clear wipes it", async () => {
    vi.spyOn(gemini, "validateApiKey").mockResolvedValue({ availableModels: [] });
    const { result } = renderHook(() => useApiKey(), { wrapper });

    act(() => result.current.setKey("AIza-remember"));
    act(() => result.current.setRemember(true));
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe("AIza-remember"));

    act(() => result.current.clear());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(result.current.remember).toBe(false);
    expect(result.current.status.state).toBe("empty");
  });

  it("restores a remembered key on mount and auto-validates it (fresh test)", async () => {
    localStorage.setItem(STORAGE_KEY, "AIza-stored");
    const spy = vi.spyOn(gemini, "validateApiKey").mockResolvedValue({
      availableModels: ["gemini-3.1-flash-lite-image"],
    });
    const { result } = renderHook(() => useApiKey(), { wrapper });
    expect(result.current.remember).toBe(true);
    expect(result.current.ready).toBe(false); // stored != instantly validated
    await waitFor(() => expect(result.current.status.state).toBe("valid"));
    expect(result.current.apiKey).toBe("AIza-stored");
    expect(spy).toHaveBeenCalledWith("AIza-stored", expect.anything());
  });

  it("does not auto-validate when no key is stored", async () => {
    const spy = vi.spyOn(gemini, "validateApiKey").mockResolvedValue({ availableModels: [] });
    const { result } = renderHook(() => useApiKey(), { wrapper });
    expect(result.current.status.state).toBe("empty");
    await act(async () => {}); // flush the mount effect
    expect(spy).not.toHaveBeenCalled();
  });

  it("StrictMode double-mount: the aborted first auto-validation cannot strand 'validating'", async () => {
    localStorage.setItem(STORAGE_KEY, "AIza-stored");
    // Behave like the real fetch: resolve after a tick, reject with AbortError when aborted
    // (StrictMode's simulated cleanup aborts the first run; the second must still land valid).
    vi.spyOn(gemini, "validateApiKey").mockImplementation(
      (_key: string, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ availableModels: ["gemini-3.1-flash-lite-image"] }),
            5,
          );
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const { result } = renderHook(() => useApiKey(), { wrapper: strictWrapper });
    await waitFor(() => expect(result.current.status.state).toBe("valid"));
    expect(result.current.apiKey).toBe("AIza-stored");
  });

  it("a key edited during boot auto-validation supersedes the stale result", async () => {
    localStorage.setItem(STORAGE_KEY, "AIza-stored");
    let release: (v: { availableModels: string[] }) => void = () => {};
    vi.spyOn(gemini, "validateApiKey").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useApiKey(), { wrapper });
    await waitFor(() => expect(result.current.status.state).toBe("validating"));

    // The user types a new key while the boot check is in flight.
    act(() => result.current.setKey("AIza-new"));
    await act(async () => {
      release({ availableModels: ["gemini-3.1-flash-lite-image"] });
    });
    // The stale boot result must not mark the NEW key valid.
    expect(result.current.status).toMatchObject({ state: "unvalidated", key: "AIza-new" });
    expect(result.current.ready).toBe(false);
  });

  it("surfaces a fatal error as an invalid status with the friendly message", async () => {
    vi.spyOn(gemini, "validateApiKey").mockRejectedValue(
      new gemini.GeminiFatalError("Invalid or unauthorized API key."),
    );
    const { result } = renderHook(() => useApiKey(), { wrapper });
    act(() => result.current.setKey("bad"));
    await act(async () => {
      await result.current.validate();
    });
    expect(result.current.status).toMatchObject({
      state: "invalid",
      error: "Invalid or unauthorized API key.",
    });
  });
});

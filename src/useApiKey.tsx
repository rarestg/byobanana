// BYOK key state + two-phase validation, memory-first.
//
// The key lives in React state (gone on reload). The "Remember" opt-in (over the
// default "This session only") mirrors it into localStorage[STORAGE_KEY] as plaintext,
// a deliberate, warned trade-off (see the panel's cost warning). Validation is abortable and versioned so
// a stale in-flight check for an OLD key can never mark a NEWLY-edited key valid.
// Pattern adapted from rarestg/pdf-split-parse src/App.tsx (remember-key + fresh test).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { GeminiFatalError, validateApiKey } from "./core/gemini";

export const STORAGE_KEY = "nano-banana-web:gemini-key";

export type KeyStatus =
  | { state: "empty" }
  | { state: "unvalidated"; key: string }
  | { state: "validating"; key: string }
  | { state: "valid"; key: string; availableModels: string[] }
  | { state: "invalid"; key: string; error: string };

export interface ApiKeyContextValue {
  status: KeyStatus;
  remember: boolean;
  /** True once the key is validated — the readiness gate P2/P3 consume. */
  ready: boolean;
  /** The validated key value, or undefined until ready. P3 passes this to generateImage. */
  apiKey: string | undefined;
  setKey: (value: string) => void;
  setRemember: (value: boolean) => void;
  validate: () => Promise<void>;
  clear: () => void;
}

const ApiKeyContext = createContext<ApiKeyContextValue | null>(null);

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  // Restore a remembered key on first mount (opt-in persistence).
  const [remember, setRememberState] = useState<boolean>(() => readStored() !== "");
  const [status, setStatus] = useState<KeyStatus>(() => {
    const stored = readStored();
    return stored ? { state: "unvalidated", key: stored } : { state: "empty" };
  });

  // Monotonic version + abort controller guard the validation race.
  const versionRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight validation on unmount so it can't resolve into a dead tree.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const currentKey = "key" in status ? status.key : "";

  // Persist or clear the remembered key whenever it (or the toggle) changes.
  useEffect(() => {
    try {
      if (remember && currentKey) localStorage.setItem(STORAGE_KEY, currentKey);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable (private mode) — key still works in memory */
    }
  }, [remember, currentKey]);

  const setKey = useCallback((value: string) => {
    // Any edit invalidates the prior validation and cancels an in-flight check.
    versionRef.current += 1;
    controllerRef.current?.abort();
    const trimmed = value.trim();
    setStatus(trimmed ? { state: "unvalidated", key: trimmed } : { state: "empty" });
  }, []);

  const setRemember = useCallback((value: boolean) => setRememberState(value), []);

  const clear = useCallback(() => {
    versionRef.current += 1;
    controllerRef.current?.abort();
    setRememberState(false);
    setStatus({ state: "empty" });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
  }, []);

  const validate = useCallback(async () => {
    const key = "key" in status ? status.key : "";
    if (!key) {
      setStatus({ state: "empty" });
      return;
    }
    const version = ++versionRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus({ state: "validating", key });
    try {
      const { availableModels } = await validateApiKey(key, { signal: controller.signal });
      if (version !== versionRef.current) return; // a newer key superseded this check
      setStatus({ state: "valid", key, availableModels });
    } catch (error) {
      if (version !== versionRef.current) return; // stale result — ignore
      if (controller.signal.aborted) return;
      // A fatal error means the key is genuinely bad; anything else (429/5xx/timeout/
      // network) is transient — say "try again" rather than branding the key invalid.
      const message =
        error instanceof GeminiFatalError
          ? error.message
          : "Couldn't validate the key right now — the provider could not be reached or is busy. Check your connection and try again.";
      setStatus({ state: "invalid", key, error: message });
    }
  }, [status]);

  // Auto-validate a remembered key on boot (the "fresh test" half of the remember-key
  // pattern): a free GET /v1beta/models, so a returning user lands ready without reopening
  // the modal. Mount-only ([] deps): the closure captures the BOOT status, so a key the user
  // types later never auto-submits. StrictMode's setup→cleanup→setup aborts the first check
  // (via the unmount-abort effect) and the second setup starts a fresh, higher-versioned one —
  // the versioned validate() ignores the aborted run, so status can't strand at "validating".
  // An edit during the check bumps the version and the stale result is dropped.
  useEffect(() => {
    if (status.state === "unvalidated" && remember) void validate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: ApiKeyContextValue = {
    status,
    remember,
    ready: status.state === "valid",
    apiKey: status.state === "valid" ? status.key : undefined,
    setKey,
    setRemember,
    validate,
    clear,
  };

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKey(): ApiKeyContextValue {
  const context = useContext(ApiKeyContext);
  if (!context) throw new Error("useApiKey must be used within an ApiKeyProvider");
  return context;
}

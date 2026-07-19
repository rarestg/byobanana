// A same-origin, cross-tab signal for history auto-refresh: every repository write that changes
// what the history rail shows (createSession, startCandidate, writeCandidateResult, recordExport,
// clear, and recover when it actually recovered something) posts "sessions-changed"; every open
// tab re-lists sessions on receipt (see also the focus/visibilitychange listeners in Workbench,
// for tabs that missed the ping while hidden/backgrounded).
// BroadcastChannel is unavailable in some older browsers and in the jsdom test environment; a
// null channel makes every operation here a harmless no-op.

export type SessionsChannelMessage = { type: "sessions-changed" };

const CHANNEL_NAME = "nano-banana-web:sessions";

export const sessionsChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;

export function postSessionsChanged(): void {
  sessionsChannel?.postMessage({ type: "sessions-changed" } satisfies SessionsChannelMessage);
}

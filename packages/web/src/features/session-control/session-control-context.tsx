"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { SessionControlActions, UseSessionControl } from "./types";

interface SessionControlContextValue {
  sessionId: string;
  actions: SessionControlActions;
}

const SessionControlContext = createContext<SessionControlContextValue | null>(null);

/**
 * Makes `sessionId` + the session RPC actions (design §4.4: `message`,
 * `perm.answer`, `interrupt`, `takeControl`, `setMode`) available to every
 * `Composer`/`PermCard`/`ControlBar` under a session screen without
 * threading them through `Timeline` -> `TimelineRow` -> every `ToolCard` —
 * those components render whatever `RenderItem[]` the reducer produced and
 * have no reason to know about session control at all.
 */
export function SessionControlProvider({
  sessionId,
  useControl,
  children,
}: {
  sessionId: string;
  useControl: UseSessionControl;
  children: ReactNode;
}) {
  const actions = useControl(sessionId);
  const value = useMemo(() => ({ sessionId, actions }), [sessionId, actions]);

  return <SessionControlContext.Provider value={value}>{children}</SessionControlContext.Provider>;
}

/** Throws outside a `SessionControlProvider` — a `PermCard`/`Composer`/
 * `ControlBar` rendered without one is a wiring bug, not a state to degrade
 * gracefully from (design principle: no silent failures). */
export function useSessionControl(): SessionControlContextValue {
  const value = useContext(SessionControlContext);
  if (!value) {
    throw new Error("useSessionControl() must be used within a <SessionControlProvider>");
  }
  return value;
}

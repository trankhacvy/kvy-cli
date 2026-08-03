"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_THEME, parseTheme, THEME_STORAGE_KEY, type Theme } from "./theme";

/**
 * Appearance store — one module-level
 * source of truth shared by every `useTheme()` caller, same
 * `useSyncExternalStore` external-store shape as `document-title-store.ts`.
 * Reads/writes `localStorage` directly (guarded — this module is imported
 * from both client components and, transitively, files that could in
 * principle run during the static prerender, so nothing here may assume
 * `window`/`document` exist at module-eval time).
 */

const listeners = new Set<() => void>();
let current: Theme = DEFAULT_THEME;
let initialized = false;
let storageListenerAttached = false;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Cross-tab sync (next-themes' own pattern, referenced in this file's
 * docstring): another same-origin tab writing `THEME_STORAGE_KEY` fires a
 * `storage` event on every *other* open tab (never the tab that wrote it),
 * so this only needs to adopt the new value and notify — no origin/write
 * loop risk. Attached lazily, once, from the first `subscribe()` call
 * rather than at module-eval time, since this module can be imported where
 * `window` doesn't exist (see the module docstring). */
function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== THEME_STORAGE_KEY) return;
  const next = parseTheme(event.newValue);
  if (next === current) return;
  current = next;
  initialized = true;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", next === "dark");
  }
  notify();
}

function ensureStorageListenerAttached(): void {
  if (storageListenerAttached || typeof window === "undefined") return;
  storageListenerAttached = true;
  window.addEventListener("storage", handleStorageEvent);
}

/** Applies `theme` to the live DOM (`<html>` class — `globals.css`'s `.dark`
 * variant) and persists it, best-effort, for next load. */
export function setTheme(theme: Theme): void {
  current = theme;
  initialized = true;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode, quota, disabled) — the
      // class toggle above already applied; persistence is best-effort.
    }
  }
  notify();
}

function ensureInitialized(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try {
    current = parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    current = DEFAULT_THEME;
  }
}

function subscribe(listener: () => void): () => void {
  ensureStorageListenerAttached();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Theme {
  ensureInitialized();
  return current;
}

/** Always `DEFAULT_THEME` — matches `layout.tsx`'s static SSR class so
 * `useSyncExternalStore` never reports a hydration mismatch; the
 * pre-hydration script (also `layout.tsx`) has already corrected the live
 * DOM by the time any client code runs, and `getSnapshot` picks that up on
 * the very next client render. */
function getServerSnapshot(): Theme {
  return DEFAULT_THEME;
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [theme, setTheme];
}

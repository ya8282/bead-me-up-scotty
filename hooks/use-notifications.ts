"use client";
import * as React from "react";
import { toast } from "sonner";
import { useActivity } from "@/hooks/use-beads";
import { useApp } from "@/components/app-context";
import { needsHuman } from "@/lib/beads-view";
import { useGoalRuns } from "@/hooks/use-goal";
import type { View } from "@/lib/views";

/**
 * Opt-in desktop/toast notifications for Mission Control. Fires when an agent
 * finishes a bead, a bead becomes blocked, or a new bead is escalated for a
 * human decision. Built on the existing activity feed + beads (SSE-driven), so
 * no extra stream is opened. Preferences are per-device, so they live in
 * localStorage rather than the server-side app config.
 */

const PREFS_KEY = "bmus.notifications";
const OPEN_BEAD_EVENT = "bmus:open-bead";

export interface NotifPrefs {
  enabled: boolean;
  finished: boolean;
  blocked: boolean;
  escalation: boolean;
  goalWaiting: boolean;
  goalDone: boolean;
}
const DEFAULTS: NotifPrefs = {
  enabled: false,
  finished: true,
  blocked: true,
  escalation: true,
  goalWaiting: true,
  goalDone: true,
};

export function loadPrefs(): NotifPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") as Partial<NotifPrefs>) };
  } catch {
    return DEFAULTS;
  }
}
/**
 * Watching goal runs costs a `claude agents` subprocess every few seconds, so
 * the watcher only polls while those notifications are on. Settings writes
 * prefs in the same tab, which no storage event reports, hence this subscription.
 */
const prefListeners = new Set<() => void>();
function savePrefs(p: NotifPrefs) {
  if (typeof window !== "undefined") localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  for (const notify of prefListeners) notify();
}
function subscribePrefs(notify: () => void) {
  prefListeners.add(notify);
  return () => void prefListeners.delete(notify);
}
function watchingGoals(): boolean {
  const p = loadPrefs();
  return p.enabled && (p.goalWaiting || p.goalDone);
}

type Permission = NotificationPermission | "unsupported";

export function useNotificationPrefs() {
  // This hook only runs in the Settings view, which is reached via client-side
  // view switching (never server-rendered), so reading localStorage in the lazy
  // initializer is safe and avoids a setState-in-effect.
  const [prefs, setPrefsState] = React.useState<NotifPrefs>(() => loadPrefs());
  const [permission, setPermission] = React.useState<Permission>(() =>
    typeof window !== "undefined" && "Notification" in window
      ? Notification.permission
      : "unsupported",
  );

  const setPrefs = React.useCallback((p: NotifPrefs) => {
    setPrefsState(p);
    savePrefs(p);
  }, []);

  const requestPermission = React.useCallback(async (): Promise<Permission> => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    const res = await Notification.requestPermission();
    setPermission(res);
    return res;
  }, []);

  return { prefs, setPrefs, permission, requestPermission };
}

function currentProjectId(): string | null {
  if (typeof window === "undefined") return null;
  const match = /^\/p\/([^/]+)\/?$/.exec(window.location.pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** What a notification opens: the bead it is about, or the view that shows it. */
export type NotifTarget = { bead: string } | { view: View };

/** Activate a notification without retaining a component callback that may have
 * been unmounted after the user switched projects. */
export function activateNotification(projectId: string, target: NotifTarget) {
  if (typeof window === "undefined") return;
  if (currentProjectId() === projectId) {
    const event = new CustomEvent(OPEN_BEAD_EVENT, {
      cancelable: true,
      detail: { projectId, target },
    });
    // A transition can update the URL before the incoming AppShell listener is
    // mounted. In that narrow window, fall through to the URL landing route.
    if (!window.dispatchEvent(event)) return;
  }
  const query =
    "bead" in target ? `bead=${encodeURIComponent(target.bead)}` : `view=${encodeURIComponent(target.view)}`;
  window.location.assign(`/p/${encodeURIComponent(projectId)}?${query}`);
}

/** Registers the current AppShell as the live, project-scoped notification
 * target. The listener is discarded when a project shell unmounts. */
export function useNotificationActivation(
  projectId: string,
  openDetail: (id: string) => void,
  setView: (view: View) => void,
) {
  React.useEffect(() => {
    const onActivate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; target?: NotifTarget }>).detail;
      if (detail?.projectId !== projectId || !detail.target) return;
      event.preventDefault();
      if ("bead" in detail.target) openDetail(detail.target.bead);
      else setView(detail.target.view);
    };
    window.addEventListener(OPEN_BEAD_EVENT, onActivate);
    return () => window.removeEventListener(OPEN_BEAD_EVENT, onActivate);
  }, [projectId, openDetail, setView]);
}

function fire(title: string, body: string, projectId: string, target: NotifTarget) {
  // Always show an in-app toast; raise a desktop Notification when granted.
  toast(title, { description: body });
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    try {
      const notification = new Notification(title, { body });
      notification.onclick = () => {
        notification.close();
        window.focus();
        activateNotification(projectId, target);
      };
    } catch {
      /* some browsers throw if called outside a user gesture — ignore */
    }
  }
}

/**
 * Side-effect-only hook (mount once inside the app). Watches the activity feed
 * and the beads list and fires notifications for new agent-finished / blocked /
 * human-escalation events. Reads prefs fresh from localStorage on each tick so
 * Settings changes apply without shared state.
 */
export function useNotificationWatcher(projectId: string) {
  const { data } = useActivity(projectId);
  const { beads, loading, error, meta } = useApp();
  const items = data?.items;

  // The demo project has no folder on disk, so it can never host a goal run.
  const watchGoals = React.useSyncExternalStore(subscribePrefs, watchingGoals, () => false);
  const runs = useGoalRuns(projectId, watchGoals && meta?.kind === "bd").data?.runs;

  const lastSeenRef = React.useRef<string | null>(null);
  const seenHumanRef = React.useRef<Set<string> | null>(null);
  const seenRunsRef = React.useRef<Map<string, string> | null>(null);

  // Agent-finished / blocked, from the activity feed.
  React.useEffect(() => {
    if (!items) return;
    const newest = items[0]?.at ?? "";
    // First tick: establish a baseline so existing history doesn't all fire.
    if (lastSeenRef.current === null) {
      lastSeenRef.current = newest;
      return;
    }
    const prevSeen = lastSeenRef.current;
    lastSeenRef.current = newest;

    const prefs = loadPrefs();
    if (!prefs.enabled) return;
    for (const it of items) {
      if (it.at <= prevSeen) break; // items are newest-first
      if (it.origin !== "agent") continue;
      if (prefs.finished && it.action === "closed") {
        fire(`🤖 ${it.actor} finished ${it.issueId}`, it.title, projectId, { bead: it.issueId });
      } else if (prefs.blocked && it.action.startsWith("marked Blocked")) {
        fire(`⛔ ${it.issueId} is blocked`, it.title, projectId, { bead: it.issueId });
      }
    }
  }, [items, projectId]);

  // New human-escalations, from the beads list.
  React.useEffect(() => {
    // `beads` is an empty fallback while the query is loading. Waiting avoids
    // treating every existing human-labelled bead as a newly raised escalation.
    if (loading || error) return;
    const current = new Set(beads.filter(needsHuman).map((b) => b.id));
    if (seenHumanRef.current === null) {
      seenHumanRef.current = current;
      return;
    }
    const prevSeen = seenHumanRef.current;
    seenHumanRef.current = current;

    const prefs = loadPrefs();
    if (!prefs.enabled || !prefs.escalation) return;
    for (const b of beads.filter(needsHuman)) {
      if (!prevSeen.has(b.id)) {
        fire(`🙋 Needs you: ${b.id}`, b.title, projectId, { bead: b.id });
      }
    }
  }, [beads, error, loading, projectId]);

  // Goal runs stopping on a question, or reaching the end of their work.
  React.useEffect(() => {
    if (!runs) return;
    const current = new Map(runs.map((r) => [r.id, r.state]));
    // First tick: baseline, so runs that were already waiting don't all fire.
    if (seenRunsRef.current === null) {
      seenRunsRef.current = current;
      return;
    }
    const prevSeen = seenRunsRef.current;
    seenRunsRef.current = current;

    const prefs = loadPrefs();
    if (!prefs.enabled) return;
    for (const run of runs) {
      const was = prevSeen.get(run.id);
      // A run first seen mid-flight has no transition to report.
      if (was === undefined || was === run.state) continue;
      const label = run.name || `${run.id} in this project`;
      if (run.state === "blocked") {
        if (prefs.goalWaiting) fire(`🙋 Goal run ${run.id} is waiting on you`, label, projectId, { view: "goals" });
      } else if (!run.live && prefs.goalDone) {
        fire(`🤖 Goal run ${run.id} finished`, label, projectId, { view: "goals" });
      }
    }
  }, [runs, projectId]);
}

export type Answer =
  | { text: string }
  | { indices: number[] }
  | { decision: string };
export interface Question {
  id: string;
  sessionKey: string;
  sessionTitle: string;
  agentName: string;
  kind: "question" | "permission";
  question: string;
  choices?: string[];
  multiSelect?: boolean;
  allowOther?: boolean;
  allowedDecisions?: string[];
  expiresAtMs: number | null;
  createdAtMs: number;
}
export interface Completion {
  id: string;
  sessionKey: string;
  agentName: string;
  sessionTitle: string;
  summary: string;
  read: boolean;
  createdAtMs: number;
}
export interface Snapshot {
  completedNextBefore?: { id: string; createdAtMs: number } | null;
  completedTotal?: number;
  unreadCompleted?: number;
  version: number;
  available: boolean;
  capabilities: {
    allGatewayQuestions: boolean;
    coverage: string;
    permissions: string;
  };
  pending: Question[];
  completed: Completion[];
}
export interface Session {
  key: string;
  label?: string;
  displayName?: string;
  title?: string;
  updatedAt?: number;
  pinned?: boolean;
  agentStatus?: {
    needsYou?: boolean;
    working?: boolean;
    failed?: boolean;
    unknown?: boolean;
  };
  actions?: { rename: boolean; hide: boolean; pin: boolean; stop: boolean };
}
export type Section = "home" | "pending" | "completed" | "sessions";
export function orderedQuestions(rows: Question[], now = Date.now()) {
  return rows
    .filter((q) => q.expiresAtMs === null || q.expiresAtMs > now)
    .sort(
      (a, b) =>
        (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity) ||
        a.createdAtMs - b.createdAtMs ||
        a.id.localeCompare(b.id),
    );
}
export function stableOrder(previous: string[], next: string[]) {
  const live = new Set(next);
  return [
    ...previous.filter((id) => live.has(id)),
    ...next.filter((id) => !previous.includes(id)),
  ];
}
export function sessionStatus(s: Session, online: boolean) {
  if (!online || s.agentStatus?.unknown) return "Нет связи";
  if (s.agentStatus?.needsYou) return "Нужен ответ";
  if (s.agentStatus?.working) return "Работает";
  if (s.agentStatus?.failed) return "Ошибка";
  return "Готово";
}
export function canSend(q: Question, now = Date.now()) {
  return q.expiresAtMs === null || q.expiresAtMs > now;
}
export class InboxModel {
  snapshot: Snapshot = {
    version: 1,
    available: false,
    capabilities: {
      allGatewayQuestions: false,
      coverage: "unknown",
      permissions: "unknown",
    },
    pending: [],
    completed: [],
  };
  order: string[] = [];
  selectedId: string | null = null;
  enter() {
    this.order = orderedQuestions(this.snapshot.pending).map((x) => x.id);
    this.retain();
  }
  update(snapshot: Snapshot) {
    const latest = new Map(snapshot.completed.map((x) => [x.id, x]));
    for (const old of this.snapshot.completed)
      if (!latest.has(old.id) && old.createdAtMs > Date.now() - 7 * 86400000)
        latest.set(old.id, old);
    this.snapshot = {
      ...snapshot,
      completed: [...latest.values()].sort(
        (a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id),
      ),
    };
    this.order = stableOrder(
      this.order,
      orderedQuestions(snapshot.pending).map((x) => x.id),
    );
    this.retain();
  }
  private retain() {
    if (!this.selectedId || !this.order.includes(this.selectedId))
      this.selectedId = this.order[0] ?? null;
  }
}

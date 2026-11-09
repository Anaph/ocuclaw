import type { Completion, Question, Snapshot } from "./model";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}
function identified(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    typeof value.id === "string" &&
    typeof value.sessionKey === "string"
  );
}
export function isSnapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.available !== "boolean" ||
    !record(value.capabilities)
  )
    return false;
  if (
    value.authorizedNamespaces != null &&
    !strings(value.authorizedNamespaces)
  )
    return false;
  if (!Array.isArray(value.pending) || !Array.isArray(value.completed))
    return false;
  return value.pending.every(isQuestion) && value.completed.every(isCompletion);
}
export function isQuestion(item: unknown): item is Question {
  return (
    identified(item) &&
    (item.kind === "question" || item.kind === "permission") &&
    typeof item.question === "string" &&
    typeof item.agentName === "string" &&
    typeof item.sessionTitle === "string" &&
    typeof item.createdAtMs === "number" &&
    Number.isFinite(item.createdAtMs) &&
    (item.expiresAtMs === null ||
      (typeof item.expiresAtMs === "number" &&
        Number.isFinite(item.expiresAtMs))) &&
    (item.choices === undefined || strings(item.choices)) &&
    (item.kind !== "permission" || strings(item.allowedDecisions)) &&
    (item.permissionCommand == null ||
      typeof item.permissionCommand === "string") &&
    (item.permissionDescription == null ||
      typeof item.permissionDescription === "string") &&
    (item.multiSelect === undefined || typeof item.multiSelect === "boolean") &&
    (item.allowOther === undefined || typeof item.allowOther === "boolean")
  );
}
export function isCompletion(item: unknown): item is Completion {
  return (
    identified(item) &&
    typeof item.summary === "string" &&
    typeof item.read === "boolean" &&
    typeof item.agentName === "string" &&
    typeof item.sessionTitle === "string" &&
    typeof item.createdAtMs === "number" &&
    Number.isFinite(item.createdAtMs)
  );
}

export function endpointScope(address: string): string {
  const url = new URL(address);
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
    throw Error("Нужен адрес ws:// или wss:// без логина и пароля");
  url.search = "";
  url.hash = "";
  return url.toString();
}

interface AnswerReceipt {
  operationId: string;
  id: string;
  sessionKey: string;
}
export class ReceiptStore {
  constructor(
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private scope: string,
  ) {}
  private get key() {
    return `ocuclaw.pendingOperation:${encodeURIComponent(this.scope)}`;
  }
  save(receipt: AnswerReceipt) {
    const entries = this.list();
    if (!entries.some((entry) => entry.operationId === receipt.operationId))
      this.storage.setItem(this.key, JSON.stringify([...entries, receipt]));
  }
  list(): AnswerReceipt[] {
    try {
      const saved = JSON.parse(this.storage.getItem(this.key) || "null");
      // Older clients stored a single receipt under this endpoint key.
      return (Array.isArray(saved) ? saved : [saved]).filter(
        (item) =>
          record(item) &&
          ["operationId", "id", "sessionKey"].every(
            (key) => typeof item[key] === "string",
          ),
      );
    } catch {
      return [];
    }
  }
  clear(operationId: string) {
    const entries = this.list();
    const remaining = entries.filter(
      (entry) => entry.operationId !== operationId,
    );
    if (remaining.length === entries.length) return;
    if (remaining.length)
      this.storage.setItem(this.key, JSON.stringify(remaining));
    else this.storage.removeItem(this.key);
  }
}

// getRandomValues is available in LAN HTTP previews where randomUUID is not.
export function randomId(provider: Crypto = crypto): string {
  if (typeof provider.randomUUID === "function") return provider.randomUUID();
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

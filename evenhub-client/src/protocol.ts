import type { Snapshot } from "./model";

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
  return (
    value.pending.every(
      (item) =>
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
        (item.multiSelect === undefined ||
          typeof item.multiSelect === "boolean") &&
        (item.allowOther === undefined || typeof item.allowOther === "boolean"),
    ) &&
    value.completed.every(
      (item) =>
        identified(item) &&
        typeof item.summary === "string" &&
        typeof item.read === "boolean" &&
        typeof item.agentName === "string" &&
        typeof item.sessionTitle === "string" &&
        typeof item.createdAtMs === "number" &&
        Number.isFinite(item.createdAtMs),
    )
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

export class ReceiptStore {
  constructor(
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private scope: string,
  ) {}
  private get key() {
    return `ocuclaw.pendingOperation:${encodeURIComponent(this.scope)}`;
  }
  save(receipt: { operationId: string; id: string; sessionKey: string }) {
    this.storage.setItem(this.key, JSON.stringify(receipt));
  }
  load(): { operationId: string; id: string; sessionKey: string } | null {
    try {
      const item = JSON.parse(this.storage.getItem(this.key) || "null");
      return item &&
        ["operationId", "id", "sessionKey"].every(
          (k) => typeof item[k] === "string",
        )
        ? item
        : null;
    } catch {
      return null;
    }
  }
  clear() {
    this.storage.removeItem(this.key);
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

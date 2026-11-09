export type Handoff = {
  kind: "question" | "result";
  id: string;
  sessionKey: string;
};

const eventName = "ocuclaw:handoff";
const key = (scope: string) => `ocuclaw.handoff:${encodeURIComponent(scope)}`;

export function readHandoff(scope: string): Handoff | null {
  if (!scope) return null;
  try {
    const item = JSON.parse(localStorage.getItem(key(scope)) || "null");
    return item &&
      ["question", "result"].includes(item.kind) &&
      typeof item.id === "string" &&
      typeof item.sessionKey === "string"
      ? item
      : null;
  } catch {
    return null;
  }
}

export function sendHandoff(scope: string, item: Handoff) {
  localStorage.setItem(key(scope), JSON.stringify(item));
  window.dispatchEvent(new Event(eventName));
}

export function clearHandoff(scope: string, item: Handoff) {
  const current = readHandoff(scope);
  if (
    current?.id === item.id &&
    current.kind === item.kind &&
    current.sessionKey === item.sessionKey
  ) {
    localStorage.removeItem(key(scope));
    window.dispatchEvent(new Event(eventName));
  }
}

export function onHandoff(callback: () => void) {
  window.addEventListener(eventName, callback);
}

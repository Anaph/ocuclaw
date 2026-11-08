// Opt-in workspace protocol; never changes the relay's selected session.
const { isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");
function createWorkspaceService({ bridge, sessions, send, now = Date.now }) {
  const subscribers = new Map();
  let timer = null,
    polling = false;
  const allowed = new Set([
    "inbox.snapshot",
    "inbox.completed",
    "inbox.get",
    "inbox.answer",
    "inbox.operation",
    "inbox.read",
    "chat.history",
    "sessions.patch",
    "sessions.abort",
    "agent",
    "workspace.stt.providers",
    "workspace.stt.transcribe",
  ]);
  const titles = new Map();
  async function snapshot() {
    const data = await bridge.request("inbox.snapshot", {});
    const keys = new Set(
      [...data.pending, ...data.completed].map((x) => x.sessionKey),
    );
    for (const key of keys) {
      let cached = titles.get(key);
      if (!cached || cached.until < now()) {
        try {
          const result = await bridge.request("sessions.list", {
            search: key,
            originalText: true,
            limit: 1,
          });
          const row = result.sessions?.find((x) => x.key === key);
          cached = {
            title: row?.label || row?.displayName || key,
            until: now() + 30000,
          };
          titles.set(key, cached);
        } catch {
          cached = { title: key, until: now() + 5000 };
          titles.set(key, cached);
        }
      }
      for (const item of [...data.pending, ...data.completed])
        if (item.sessionKey === key) item.sessionTitle = cached.title;
    }
    for (const key of titles.keys()) if (!keys.has(key)) titles.delete(key);
    return data;
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const [id, sub] of subscribers)
        if (sub.until < now()) subscribers.delete(id);
      if (!subscribers.size) {
        clearInterval(timer);
        timer = null;
        return;
      }
      const data = await snapshot();
      const fingerprint = JSON.stringify([
        data.pending,
        data.completed,
        data.available,
        data.unreadCompleted,
        data.completedTotal,
        data.capabilities,
      ]);
      for (const [id, sub] of subscribers)
        if (sub.fingerprint !== fingerprint) {
          sub.fingerprint = fingerprint;
          send(id, { type: "ocuclaw.workspace.changed", version: 1, data });
        }
    } catch {
      for (const id of subscribers.keys())
        send(id, { type: "ocuclaw.workspace.unavailable", version: 1 });
    } finally {
      polling = false;
    }
  }
  async function request(clientId, frame) {
    const reply = (data) => ({
      unicast: JSON.stringify({
        type: "ocuclaw.workspace.result",
        id: frame.id,
        version: 1,
        data,
      }),
    });
    if (
      frame.version !== 1 ||
      typeof frame.id !== "string" ||
      frame.id.length > 128 ||
      !frame.id
    )
      return reply({ error: "invalid_request" });
    const p =
      frame.params &&
      typeof frame.params === "object" &&
      !Array.isArray(frame.params)
        ? frame.params
        : {};
    try {
      if (frame.method === "capabilities")
        return reply({ version: 1, inbox: true, sessions: true, voice: true });
      if (frame.method === "inbox.subscribe") {
        if (!subscribers.has(clientId) && subscribers.size >= 32)
          throw Error("subscription_limit");
        subscribers.set(clientId, { until: now() + 45000, fingerprint: "" });
        if (!timer) {
          timer = setInterval(poll, 2000);
          timer.unref?.();
        }
        return reply(await snapshot());
      }
      if (frame.method === "sessions.list") {
        const data = await bridge.request("sessions.list", {
          limit: 500,
          search: p.search,
          originalText: true,
        });
        return reply({
          sessions: data.sessions.map((row) => ({
            ...row,
            agentStatus: row.agentStatus || { unknown: true },
            ...sessions.getSessionPin(row.key),
            actions: {
              rename: !isForeignHermesSessionKey(row.key),
              stop: !isForeignHermesSessionKey(row.key),
              hide: true,
              pin: !isForeignHermesSessionKey(row.key),
            },
          })),
        });
      }
      if (frame.method === "sessions.pin")
        return reply(
          sessions.setSessionPinned("ocuclaw", p.key, p.pinned === true),
        );
      if (frame.method === "sessions.create")
        return reply({
          key: sessions.createDetachedSessionKey("hermes:main:"),
        });
      if (!allowed.has(frame.method)) throw Error("unsupported_operation");
      return reply(await bridge.request(frame.method, p));
    } catch (error) {
      return reply({ error: String(error.message || "request_failed") });
    }
  }
  return {
    request,
    disconnect(id) {
      subscribers.delete(id);
    },
    close() {
      clearInterval(timer);
      subscribers.clear();
    },
  };
}
module.exports = { createWorkspaceService };

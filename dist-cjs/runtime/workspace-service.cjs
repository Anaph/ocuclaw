// Opt-in workspace protocol; never changes the relay's selected session.
const { createWorkspaceUploads } = require("./workspace-uploads.cjs");
const { isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");
function createWorkspaceService({ bridge, sessions, send, now = Date.now }) {
  const subscribers = new Map();
  const chatSubscribers = new Map();
  const uploads = createWorkspaceUploads(now);
  const off = ["streaming", "message", "activity"]
    .map((name) =>
      bridge.on?.(name, (data) => {
        if (!data || typeof data.sessionKey !== "string") return;
        for (const [id, sub] of chatSubscribers)
          if (sub.until >= now() && sub.key === data.sessionKey)
            send(id, {
              type: "ocuclaw.workspace.chat",
              version: 1,
              event: name,
              data,
            });
      }),
    )
    .filter(Boolean);
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
    "workspace.send.receipt",
    "workspace.stt.providers",
    "workspace.stt.transcribe",
  ]);
  const titles = new Map();
  let snapshotPending = null,
    closed = false;
  const titleQueue = new Set(),
    titleActive = new Set();
  function hydrateTitles() {
    if (closed) return;
    while (titleActive.size < 4 && titleQueue.size) {
      const key = titleQueue.values().next().value;
      titleQueue.delete(key);
      titleActive.add(key);
      void (async () => {
        let cached;
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
        } catch {
          cached = { title: key, until: now() + 5000 };
        }
        if (!closed) titles.set(key, cached);
      })().finally(() => {
        titleActive.delete(key);
        hydrateTitles();
      });
    }
  }
  function snapshot() {
    if (snapshotPending) return snapshotPending;
    const work = Promise.resolve()
      .then(() => bridge.request("inbox.snapshot", {}))
      .then((raw) => {
        const decorate = (item) => {
          const key = item.sessionKey,
            cached = titles.get(key);
          if ((!cached || cached.until < now()) && !titleActive.has(key))
            titleQueue.add(key);
          return {
            ...item,
            sessionTitle: cached?.title || item.sessionTitle || key,
          };
        };
        const data = {
          ...raw,
          pending: raw.pending.map(decorate),
          completed: raw.completed.map(decorate),
        };
        const live = new Set(
          [...data.pending, ...data.completed].map((x) => x.sessionKey),
        );
        for (const key of titles.keys()) if (!live.has(key)) titles.delete(key);
        for (const key of titleQueue)
          if (!live.has(key)) titleQueue.delete(key);
        hydrateTitles();
        return data;
      });
    snapshotPending = work;
    void work.then(
      () => {
        if (snapshotPending === work) snapshotPending = null;
      },
      () => {
        if (snapshotPending === work) snapshotPending = null;
      },
    );
    return work;
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
      for (const [id, sub] of chatSubscribers)
        if (
          sub.until < now() ||
          (Array.isArray(data.authorizedNamespaces) &&
            !data.authorizedNamespaces.includes(sub.key.split(":")[1]))
        )
          chatSubscribers.delete(id);
      const fingerprint = JSON.stringify([
        data.pending,
        data.completed,
        data.available,
        data.unreadCompleted,
        data.completedTotal,
        data.capabilities,
        data.authorizedNamespaces,
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
        return reply({
          version: 1,
          inbox: true,
          sessions: true,
          voice: true,
          chatStream: true,
          catalog: true,
          schedules: true,
          uploads: uploads.limits,
        });
      if (frame.method.startsWith("uploads."))
        return reply(uploads.request(clientId, frame.method, p));
      if (frame.method === "workspace.catalog") {
        const [agents, models] = await Promise.all([
          bridge.request("agents.list", {}),
          bridge.request("workspace.models", {
            profileId: p.profileId || "default",
          }),
        ]);
        return reply({ ...agents, ...models });
      }
      if (
        frame.method.startsWith("automations.") ||
        frame.method.startsWith("jobs.")
      ) {
        const operations = new Set([
          "automations.options",
          "automations.read",
          "automations.preview",
          "automations.draft",
          "automations.create",
          "automations.update",
          "automations.delete",
          "automations.receipt",
          "jobs.list",
          "jobs.history",
          "jobs.pause",
          "jobs.resume",
          "jobs.run",
          "jobs.stop",
          "jobs.receipt",
        ]);
        if (!operations.has(frame.method)) throw Error("unsupported_operation");
        return reply(
          await bridge.request("workspace.schedule", {
            ...p,
            operation: frame.method,
          }),
        );
      }
      if (frame.method === "chat.subscribe") {
        if (
          typeof p.sessionKey !== "string" ||
          !p.sessionKey.startsWith("hermes:") ||
          p.sessionKey.length > 512
        )
          throw Error("invalid_session");
        // Reading first is also the live admission check. No global selected chat changes.
        const history = await bridge.request(
          /:x:cron:/.test(p.sessionKey)
            ? "workspace.cron.history"
            : "chat.history",
          { sessionKey: p.sessionKey, limit: 30 },
        );
        chatSubscribers.set(clientId, {
          key: p.sessionKey,
          until: now() + 45000,
        });
        return reply(history);
      }
      if (frame.method === "chat.unsubscribe") {
        chatSubscribers.delete(clientId);
        return reply({ ok: true });
      }
      if (
        frame.method === "chat.history" &&
        /:x:cron:/.test(p.sessionKey || "")
      )
        return reply(await bridge.request("workspace.cron.history", p));
      if (frame.method === "agent") {
        if (p.attachments !== undefined)
          throw Error("use_authenticated_uploads");
        return reply(
          await bridge.request("workspace.send", {
            ...p,
            attachments: uploads.descriptors(clientId, p.uploadIds || []),
          }),
        );
      }
      if (frame.method === "inbox.subscribe") {
        if (!subscribers.has(clientId) && subscribers.size >= 32)
          throw Error("subscription_limit");
        const previous = subscribers.get(clientId);
        subscribers.set(clientId, {
          until: now() + 45000,
          fingerprint: previous?.fingerprint || "",
        });
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
          includeHidden: p.includeHidden === true,
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
      if (frame.method === "sessions.create") {
        const catalog = await bridge.request("agents.list", {});
        const profile = p.profileId || "default";
        if (!catalog.agents?.some((x) => x.id === profile))
          throw Error("profile_not_served");
        const ns = profile === "default" ? "main" : profile;
        if (!/^[A-Za-z0-9_-]+$/.test(ns)) throw Error("invalid_profile");
        const key = sessions.createDetachedSessionKey(`hermes:${ns}:`, {
          agentRef: profile,
        });
        if (!key.startsWith(`hermes:${ns}:`))
          throw Error("profile_affinity_mismatch");
        if (p.model) {
          const catalog = await bridge.request("workspace.models", {
            profileId: profile,
          });
          if (
            !catalog.models?.some(
              (row) => row.id === p.model && row.provider === p.provider,
            )
          )
            throw Error("model_unavailable");
          await bridge.request("sessions.patch", {
            key,
            model: p.model,
            modelProvider: p.provider,
            initial: true,
            confirmModelSelection: true,
            perSessionOnly: true,
          });
        }
        return reply({ key });
      }
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
      chatSubscribers.delete(id);
      uploads.release(id);
    },
    close() {
      closed = true;
      for (const unsubscribe of off) unsubscribe();
      chatSubscribers.clear();
      uploads.close();
      titleQueue.clear();
      titles.clear();
      clearInterval(timer);
      subscribers.clear();
    },
  };
}
module.exports = { createWorkspaceService };

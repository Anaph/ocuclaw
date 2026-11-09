import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Workspace,
  scheduleExpression,
  scheduleForm,
  serializeSchedule,
} from "./workspace";
import { InboxModel } from "./model";
import type { Relay } from "./transport";
function harness(request: (method: string, p: any) => Promise<any>) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) || null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  };
  const observers: any[] = [];
  const relay = {
    capabilities: {},
    observe: (o: any) => {
      observers.push(o);
      return () => {};
    },
    request,
  } as unknown as Relay;
  return {
    workspace: new Workspace(relay, new InboxModel(), storage),
    values,
    observers,
  };
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
const message = (id: number) => ({
  id,
  role: "assistant",
  content: String(id),
});
test("drafts are isolated by server and chat, reconnect never sends them", () => {
  let sends = 0;
  const { workspace: w } = harness(async () => {
    sends++;
    return {};
  });
  w.reset("wss://a.test");
  w.chatKey = "hermes:main:a";
  w.saveDraft("A");
  w.chatKey = "hermes:main:b";
  assert.equal(w.draft(), "");
  w.saveDraft("B");
  w.reset("wss://b.test");
  w.chatKey = "hermes:main:a";
  assert.equal(w.draft(), "");
  w.reset("wss://a.test");
  w.chatKey = "hermes:main:a";
  assert.equal(w.draft(), "A");
  assert.equal(sends, 0);
});
test("a stale server response cannot replace current chat data", async () => {
  let resolve: (v: any) => void = () => {};
  const { workspace: w } = harness(() => new Promise((r) => (resolve = r)));
  w.reset("wss://a.test");
  const pending = w.openChat("hermes:main:a");
  w.reset("wss://b.test");
  resolve({ messages: [{ role: "assistant", content: "A secret" }] });
  await assert.rejects(pending, /Подключение изменилось/);
  assert.deepEqual(w.messages, []);
  assert.equal(w.chatKey, "");
});
test("background events and pending refreshes cannot replace user navigation", async () => {
  const opening = deferred(),
    refresh = deferred();
  const { workspace: w, observers } = harness(async (method, params) => {
    if (method === "chat.history") return refresh.promise;
    return params.sessionKey.endsWith(":b")
      ? opening.promise
      : { messages: [message(1)] };
  });
  await w.openChat("hermes:main:a");
  const old = w.refreshChat();
  const next = w.openChat("hermes:main:b");
  observers[0].chat({
    event: "message",
    data: { sessionKey: "hermes:main:a" },
  });
  opening.resolve({ messages: [message(2)] });
  await next;
  assert.equal(w.chatKey, "hermes:main:b");
  await w.closeChat();
  refresh.resolve({ messages: [message(1)] });
  await old;
  assert.equal(w.chatKey, "");
  assert.deepEqual(w.messages, []);
});
test("the first page exposes older messages and refresh keeps loaded history", async () => {
  const { workspace: w } = harness(async (method, params) => {
    if (params.beforeId === 4)
      return {
        messages: [message(2), message(3)],
        hasMore: true,
        nextBeforeId: 2,
      };
    if (method === "chat.subscribe")
      return { messages: [message(4), message(5)], total: 5 };
    return { messages: [message(5), message(6)], total: 6 };
  });
  await w.openChat("hermes:main:a");
  assert.equal(w.hasMore, true);
  await w.older();
  await w.refreshChat();
  assert.equal(w.nextBeforeId, 2);
  assert.deepEqual(
    w.messages.map((row) => row.id),
    [2, 3, 4, 5, 6],
  );
});
test("stream subscriptions ignore other sessions and reordered frames", () => {
  const { workspace: w, observers } = harness(async () => ({}));
  w.chatKey = "hermes:main:a";
  observers[0].chat({
    event: "streaming",
    data: { sessionKey: "hermes:main:b", runId: "a", seq: 1, text: "Wrong" },
  });
  assert.equal(w.liveText, "");
  observers[0].chat({
    event: "streaming",
    data: { sessionKey: w.chatKey, runId: "a", seq: 2, text: "Latest" },
  });
  observers[0].chat({
    event: "streaming",
    data: { sessionKey: w.chatKey, runId: "a", seq: 1, text: "Old" },
  });
  assert.equal(w.liveText, "Latest");
});
test("lost schedule ack retains the original operation and explicit retry checks its receipt", async () => {
  const calls: any[] = [];
  let first = true;
  const { workspace: w } = harness(async (method, p) => {
    calls.push({ method, p });
    if (method === "automations.create" && first) {
      first = false;
      throw Error("network");
    }
    if (method === "automations.receipt") return { status: "not_found" };
    return { status: "saved" };
  });
  w.reset("wss://a.test");
  await assert.rejects(
    w.mutateSchedule("automations.create", { fields: { name: "A" } }),
    /network/,
  );
  await assert.rejects(
    w.mutateSchedule("automations.create", {}),
    /предыдущую/,
  );
  await w.retrySchedule();
  assert.equal(calls[1].method, "automations.receipt");
  assert.equal(calls[0].p.operationId, calls[2].p.operationId);
  assert.deepEqual(calls[0].p.fields, calls[2].p.fields);
});
test("forms only serialize schedule expressions; they never calculate fire times", () => {
  assert.equal(
    scheduleExpression("weekly", "", "09:30", ["1", "5"], "", ""),
    "30 9 * * 1,5",
  );
  assert.equal(
    scheduleExpression("daily", "", "08:00", [], "", ""),
    "0 8 * * *",
  );
  assert.equal(
    scheduleExpression("interval", "", "", [], "2h", ""),
    "every 2h",
  );
  assert.equal(
    scheduleExpression("once", "2027-01-01", "10:00", [], "", ""),
    "2027-01-01T10:00:00",
  );
  assert.throws(
    () => scheduleExpression("weekly", "", "09:30", [], "", ""),
    /дни/,
  );
});
test("editing metadata preserves exact schedules including explicit offsets and seconds", () => {
  for (const existing of ["2027-01-01T10:00:37+03:00", "00 09 * * 5,1"]) {
    const form = scheduleForm(existing);
    form.days.reverse();
    assert.equal(serializeSchedule(form, existing), existing);
  }
  const form = scheduleForm("0 9 * * *");
  form.time = "10:30";
  assert.equal(serializeSchedule(form, "0 9 * * *"), "30 10 * * *");
});
test("a schedule retry cannot move to another profile during receipt lookup", async () => {
  const receipt = deferred();
  const runs: string[] = [];
  const { workspace: w, values } = harness(async (method, params) => {
    if (method === "automations.receipt") return receipt.promise;
    if (method === "jobs.run") {
      runs.push(params.profileId);
      throw Error("network");
    }
    return {};
  });
  await assert.rejects(w.mutateSchedule("jobs.run", { jobId: "a" }), /network/);
  const retry = w.retrySchedule();
  await w.loadJobs("research");
  receipt.resolve({ status: "not_found" });
  await assert.rejects(retry, /Профиль|профиль/);
  assert.deepEqual(runs, ["default"]);
  assert.equal(values.size, 1);
});
test("a late mutation receipt only clears the originating profile", async () => {
  const ack = deferred();
  const { workspace: w, values } = harness(async (method, params) => {
    if (method === "jobs.run") {
      if (params.profileId === "default") return ack.promise;
      throw Error("network");
    }
    return {};
  });
  const first = w.mutateSchedule("jobs.run", { jobId: "a" });
  await w.loadJobs("research");
  await assert.rejects(w.mutateSchedule("jobs.run", { jobId: "b" }), /network/);
  ack.resolve({ status: "applied" });
  await first;
  assert.deepEqual(
    [...values.keys()].map((key) => key.split(":").at(-1)),
    ["research"],
  );
});

test("accepted send receipt prevents a second send after a lost acknowledgment", async () => {
  let sends = 0;
  const { workspace: w } = harness(async (method) => {
    if (method === "agent") {
      sends++;
      throw Error("network");
    }
    if (method === "workspace.send.receipt")
      return { status: "accepted", runId: "original" };
    if (method === "chat.history") return { messages: [] };
    return {};
  });
  w.reset("wss://a.test");
  w.chatKey = "hermes:main:a";
  w.saveDraft("Сообщение");
  await assert.rejects(w.send("Сообщение", []), /network/);
  assert.equal(w.pendingSend()?.text, "Сообщение");
  const result = await w.send("Сообщение", []);
  assert.equal(result.runId, "original");
  assert.equal(sends, 1);
  assert.equal(w.pendingSend(), null);
  assert.equal(w.draft(), "");
});
test("a rejected send receipt keeps the draft and allows a new operation", async () => {
  const sent: string[] = [];
  const { workspace: w } = harness(async (method, p) => {
    if (method === "workspace.send.receipt")
      return { status: "rejected", error: "rejected by Hermes" };
    if (method === "agent") {
      sent.push(p.idempotencyKey);
      if (sent.length === 1) throw Error("network");
      return { status: "accepted" };
    }
    throw Error("history temporarily unavailable");
  });
  w.chatKey = "hermes:main:a";
  w.saveDraft("Старый черновик");
  await assert.rejects(w.send(w.draft(), []), /network/);
  await assert.rejects(w.send(w.draft(), []), /rejected by Hermes/);
  assert.equal(w.pendingSend(), null);
  assert.equal(w.draft(), "Старый черновик");
  await w.send(w.draft(), []);
  assert.notEqual(sent[0], sent[1]);
  assert.equal(w.draft(), "");
});
test("send preserves draft edits made while the agent acknowledges", async () => {
  const ack = deferred();
  const { workspace: w } = harness(async (method) => {
    if (method === "agent") return ack.promise;
    throw Error("history temporarily unavailable");
  });
  w.chatKey = "hermes:main:a";
  w.saveDraft("Исходное");
  const send = w.send(w.draft(), []);
  w.saveDraft("Следующее");
  ack.resolve({ status: "accepted" });
  await send;
  assert.equal(w.draft(), "Следующее");
});
test("a failed attachment batch cancels earlier uploads without issuing a send", async () => {
  const calls: string[] = [];
  const { workspace: w } = harness(async (method, p) => {
    calls.push(method);
    if (method === "uploads.begin") {
      if (p.fileName === "second.txt") throw Error("upload_limit");
      return { id: "upload-1", chunkBytes: 64 };
    }
    if (method === "uploads.cancel") assert.equal(p.id, "upload-1");
    return {};
  });
  w.relay.capabilities.uploads = { fileBytes: 64 };
  w.chatKey = "hermes:main:a";
  const files = [new File(["a"], "first.txt"), new File(["b"], "second.txt")];
  await assert.rejects(w.send("Два файла", files), /upload_limit/);
  assert.deepEqual(calls, [
    "uploads.begin",
    "uploads.chunk",
    "uploads.begin",
    "uploads.cancel",
  ]);
  assert.equal(w.pendingSend(), null);
});
test("a list response cannot restore sessions from a revoked profile", async () => {
  const result = deferred();
  const { workspace: w, observers } = harness(() => result.promise);
  const list = w.list();
  observers[0].snapshot({ authorizedNamespaces: ["main"] });
  result.resolve({
    sessions: [{ key: "hermes:main:a" }, { key: "hermes:research:b" }],
  });
  await list;
  assert.deepEqual(
    w.sessions.map((row) => row.key),
    ["hermes:main:a"],
  );
});

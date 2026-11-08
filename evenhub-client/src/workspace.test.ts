import { test } from "node:test";
import assert from "node:assert/strict";
import { Workspace, scheduleExpression } from "./workspace";
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
  assert.equal(w.pendingSend().text, "Сообщение");
  const result = await w.send("Сообщение", []);
  assert.equal(result.runId, "original");
  assert.equal(sends, 1);
  assert.equal(w.pendingSend(), null);
  assert.equal(w.draft(), "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Relay } from "./transport";
class Socket {
  readyState = 0;
  onopen: any;
  onclose: any;
  onmessage: any;
  onerror: any;
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  reply(method: string, data: unknown) {
    const request = this.sent.filter((x) => x.method === method).at(-1);
    assert(request, method);
    this.frame({
      type: "ocuclaw.workspace.result",
      version: 1,
      id: request.id,
      data,
    });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const snapshot = (id = "") => ({
  version: 1,
  available: true,
  capabilities: { allGatewayQuestions: true },
  pending: [],
  completed: id
    ? [
        {
          id,
          sessionKey: "hermes:main:a",
          summary: "Готово",
          agentName: "Agent",
          sessionTitle: "Result",
          read: false,
          createdAtMs: Date.now(),
        },
      ]
    : [],
});
function harness() {
  const sockets: Socket[] = [];
  const relay = new Relay(
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    { handshake: 100, request: 100, heartbeat: 10000, reconnect: 10 },
  );
  return { relay, sockets };
}
async function ready(relay: Relay, s: Socket, id = "") {
  s.open();
  s.frame({ type: "protocolHelloAck", protocolVersion: "v2" });
  assert(!relay.online);
  s.reply("capabilities", { version: 1 });
  await tick();
  s.reply("inbox.subscribe", snapshot(id));
  await tick();
  assert(relay.online);
}

test("Workspace becomes online only after version negotiation and initial snapshot", async () => {
  const { relay, sockets } = harness();
  const states: boolean[] = [];
  relay.onState = (value) => states.push(value);
  relay.connect("ws://localhost/a", "key");
  await assert.rejects(relay.request("inbox.answer"), /не подключён/);
  await ready(relay, sockets[0]);
  assert.deepEqual(states, [true]);
  relay.disconnect();
});
test("outcome consumers receive typed rejections but bare protocol errors still reject", async () => {
  const { relay, sockets } = harness();
  relay.connect("ws://localhost/a", "key");
  const socket = sockets[0];
  try {
    await ready(relay, socket);
    const outcome = relay.request(
      "automations.receipt",
      {},
      { acceptStatus: true },
    );
    const rejection = { status: "rejected", error: "preview_expired" };
    socket.reply("automations.receipt", rejection);
    assert.deepEqual(await outcome, rejection);
    const protocolError = relay.request(
      "automations.receipt",
      {},
      { acceptStatus: true },
    );
    socket.reply("automations.receipt", { error: "unsupported_operation" });
    await assert.rejects(protocolError, /unsupported_operation/);
    const abort = relay.request("sessions.abort");
    socket.reply("sessions.abort", {
      status: "rejected",
      error: "profile_not_served",
    });
    await assert.rejects(abort, /profile_not_served/);
  } finally {
    relay.disconnect();
  }
});
test("old socket callbacks and negotiation cannot affect another server", async () => {
  const { relay, sockets } = harness();
  const observed: any[] = [];
  relay.onSnapshot = (x) => observed.push(x);
  relay.connect("ws://localhost/a", "key");
  const old = sockets[0];
  old.open();
  old.frame({ type: "protocolHelloAck", protocolVersion: "v2" });
  old.reply("capabilities", { version: 1 });
  relay.connect("ws://localhost/b", "new-key");
  await ready(relay, sockets[1], "server-b");
  old.frame({
    type: "ocuclaw.workspace.changed",
    version: 1,
    data: snapshot("server-a"),
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].completed[0].id, "server-b");
  assert.equal(
    sockets[1].sent.filter((x) => x.method === "inbox.subscribe").length,
    1,
  );
  relay.disconnect();
});
test("invalid credential is terminal and never causes a reconnect storm", async () => {
  const { relay, sockets } = harness();
  const errors: string[] = [];
  relay.onError = (x) => errors.push(x);
  relay.connect("ws://localhost/a", "bad-key");
  sockets[0].close(4001);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sockets.length, 1);
  assert(!relay.online);
  assert.match(errors[0], /Ключ/);
  relay.disconnect();
});
test("incompatible Workspace version is rejected before commands become available", async () => {
  const { relay, sockets } = harness();
  relay.connect("ws://localhost/a", "key");
  const s = sockets[0];
  s.open();
  s.frame({ type: "protocolHelloAck", protocolVersion: "v2" });
  s.reply("capabilities", { version: 8 });
  await tick();
  assert(!relay.online);
  assert.equal(s.sent.filter((x) => x.method === "inbox.subscribe").length, 0);
  relay.disconnect();
});
test("source outage keeps the authenticated session but marks data unavailable", async () => {
  const { relay, sockets } = harness();
  const observed: any[] = [];
  relay.onSnapshot = (x) => observed.push(x);
  relay.connect("ws://localhost/a", "key");
  await ready(relay, sockets[0]);
  sockets[0].frame({ type: "ocuclaw.workspace.unavailable", version: 1 });
  assert(relay.online);
  assert.equal(observed.at(-1).available, false);
  relay.disconnect();
});
test("malformed snapshots never enter the UI", async () => {
  const { relay, sockets } = harness();
  const observed: any[] = [];
  relay.onSnapshot = (x) => observed.push(x);
  relay.connect("ws://localhost/a", "key");
  await ready(relay, sockets[0]);
  sockets[0].frame({
    type: "ocuclaw.workspace.changed",
    version: 1,
    data: { version: 1 },
  });
  assert.equal(observed.length, 1);
  assert(!relay.online);
  relay.disconnect();
});

test("large Inbox pages are joined and revoked namespaces are filtered before exposing data", async () => {
  const { relay, sockets } = harness();
  const observed: any[] = [];
  relay.onSnapshot = (value) => observed.push(value);
  relay.connect("ws://localhost/a", "key");
  const socket = sockets[0];
  try {
    socket.open();
    socket.frame({ type: "protocolHelloAck", protocolVersion: "v2" });
    socket.reply("capabilities", { version: 1 });
    await tick();
    const item = (id: string, namespace: string) => ({
      id,
      sessionKey: `hermes:${namespace}:a`,
      sessionTitle: "Session",
      agentName: "Hermes",
      kind: "question",
      question: "Prompt",
      createdAtMs: 1,
      expiresAtMs: null,
    });
    const cursor = [Number.MAX_SAFE_INTEGER, 1, "first"];
    socket.reply("inbox.subscribe", {
      ...snapshot(),
      authorizedNamespaces: ["main", "research"],
      pending: [item("first", "research")],
      pendingNextBefore: cursor,
    });
    await tick();
    assert.equal(relay.online, false);
    assert.deepEqual(socket.sent.at(-1).params.before, cursor);
    socket.reply("inbox.pending", {
      available: true,
      authorizedNamespaces: ["main"],
      pending: [item("second", "main"), item("third", "main")],
      pendingNextBefore: null,
    });
    await tick();
    assert(relay.online);
    assert.deepEqual(
      observed.at(-1).pending.map((row: { id: string }) => row.id),
      ["second", "third"],
    );
    assert.deepEqual(observed.at(-1).authorizedNamespaces, ["main"]);
  } finally {
    relay.disconnect();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InboxModel,
  orderedQuestions,
  canSend,
  sessionStatus,
  type Question,
  type Snapshot,
} from "./model";
const question = (
  id: string,
  expiresAtMs: number | null,
  createdAtMs = 1,
): Question => ({
  id,
  sessionKey: "hermes:main:" + id,
  sessionTitle: id,
  agentName: "Агент",
  kind: "question",
  question: "Вопрос?",
  expiresAtMs,
  createdAtMs,
});
const snapshot = (pending: Question[]): Snapshot => ({
  version: 1,
  available: true,
  capabilities: {
    allGatewayQuestions: true,
    coverage: "gateway",
    permissions: "mirror",
  },
  pending,
  completed: [],
});
test("deadline ordering and unlimited requests", () => {
  assert.deepEqual(
    orderedQuestions(
      [question("old", null), question("late", 300), question("soon", 200)],
      100,
    ).map((x) => x.id),
    ["soon", "late", "old"],
  );
  assert(!canSend(question("expired", 100), 100));
});
test("new arrival never moves selected question; reentry sorts", () => {
  const model = new InboxModel();
  const far = Date.now() + 100000;
  model.update(snapshot([question("a", far), question("b", far + 1)]));
  model.enter();
  model.selectedId = "b";
  model.update(
    snapshot([
      question("urgent", far - 1),
      question("a", far),
      question("b", far + 1),
    ]),
  );
  assert.deepEqual(model.order, ["a", "b", "urgent"]);
  assert.equal(model.selectedId, "b");
  model.enter();
  assert.deepEqual(model.order, ["urgent", "a", "b"]);
});
test("answer elsewhere removes only that item", () => {
  const model = new InboxModel();
  const far = Date.now() + 100000;
  model.update(snapshot([question("a", far), question("b", far)]));
  model.selectedId = "a";
  model.update(snapshot([question("b", far)]));
  assert.deepEqual(model.order, ["b"]);
  assert.equal(model.selectedId, "b");
});

test("explicit connection reset discards data from the previous server", () => {
  const model = new InboxModel(),
    now = Date.now();
  model.update({
    ...snapshot([question("server-a", now + 100000)]),
    completed: [
      {
        id: "result-a",
        sessionKey: "hermes:main:a",
        agentName: "a",
        sessionTitle: "Secret server A",
        summary: "Private",
        read: false,
        createdAtMs: now,
      },
    ],
  });
  model.reset();
  model.update(snapshot([]));
  assert.deepEqual(model.snapshot.completed, []);
  assert.deepEqual(model.order, []);
});
test("profile revocation removes cached older results and offline questions", () => {
  const model = new InboxModel(),
    now = Date.now();
  const item = question("private-question", now + 100000);
  item.sessionKey = "hermes:private:a";
  model.update({
    ...snapshot([item]),
    authorizedNamespaces: ["main", "private"],
    completed: [
      {
        id: "private-result",
        sessionKey: "hermes:private:a",
        agentName: "a",
        sessionTitle: "Private",
        summary: "Private",
        read: false,
        createdAtMs: now,
      },
    ],
  });
  model.update({
    ...snapshot([]),
    available: false,
    authorizedNamespaces: ["main"],
  });
  assert.equal(model.snapshot.pending.length, 0);
  assert.equal(model.snapshot.completed.length, 0);
});

test("stale activity observations must not claim a session is still working", () => {
  assert.equal(
    sessionStatus(
      { key: "a", agentStatus: { working: true, observedAtMs: 1000 } },
      true,
      20000,
    ),
    "Нет связи",
  );
});

test("question expiration is evaluated against the Hermes clock sample", () => {
  const model = new InboxModel();
  const remote = Date.now() - 600_000;
  const item = question("server-live", remote + 300_000);
  model.update({
    ...model.snapshot,
    available: true,
    observedAtMs: remote,
    pending: [item],
  });
  assert.deepEqual(model.order, ["server-live"]);
  assert(canSend(item, model.now()));
  assert(!canSend(item));
});

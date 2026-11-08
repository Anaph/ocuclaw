import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InboxModel,
  orderedQuestions,
  canSend,
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

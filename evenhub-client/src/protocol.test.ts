import { test } from "node:test";
import assert from "node:assert/strict";
import { ReceiptStore, endpointScope, randomId, isSnapshot } from "./protocol";
test("receipts belong to one endpoint and storage keys never include a token", () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (k: string) => entries.get(k) || null,
    setItem: (k: string, v: string) => entries.set(k, v),
    removeItem: (k: string) => entries.delete(k),
  };
  const scope = endpointScope("wss://a.test/path?token=private#fragment");
  assert(!scope.includes("private"));
  const a = new ReceiptStore(storage, scope),
    b = new ReceiptStore(storage, endpointScope("wss://b.test/path"));
  const receipt = {
    operationId: "operation-a",
    id: "question-a",
    sessionKey: "hermes:main:a",
  };
  a.save(receipt);
  assert.equal(b.load(), null);
  assert.deepEqual(a.load(), receipt);
  b.clear();
  assert.deepEqual(a.load(), receipt);
});
test("LAN development contexts get cryptographically generated UUIDs without randomUUID", () => {
  const provider = {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(3);
      return bytes;
    },
  } as unknown as Crypto;
  assert.match(
    randomId(provider),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("malformed choice data is refused before it can reach the UI", () => {
  const base = { version: 1, available: true, capabilities: {}, completed: [] };
  const question = {
    id: "q",
    sessionKey: "hermes:main:a",
    kind: "question",
    question: "Q",
    agentName: "A",
    sessionTitle: "Title",
    createdAtMs: 1,
    expiresAtMs: null,
  };
  assert(isSnapshot({ ...base, pending: [question] }));
  assert(
    !isSnapshot({
      ...base,
      pending: [{ ...question, choices: "not-an-array" }],
    }),
  );
  assert(
    !isSnapshot({
      ...base,
      pending: [{ ...question, kind: "permission", allowedDecisions: {} }],
    }),
  );
});

// Emulator test: bridge chat.history beforeId passthrough with a stub link.
const {
  createHermesGatewayBridge,
  LINK_DB_METHODS,
} = require(require('path').join(__dirname, '..', 'dist-cjs', 'runtime', 'hermes-gateway-bridge.cjs'));

(async () => {
  const calls = [];
  let serverReply = {
    messages: [
      { id: 3, role: "user", content: "\u041f\u0440\u0438\u0432\u0435\u0442" },
      { id: 4, role: "assistant", content: "\u041f\u043e\u043a\u0430" },
    ],
    sessionId: "tip1",
    total: 10,
    hasMore: true,
    nextBeforeId: 3,
  };
  const link = {
    request: async (method, params) => {
      calls.push({ method, params });
      return serverReply;
    },
  };
  const { bridge } = createHermesGatewayBridge({ link });

  const res = await bridge.request("chat.history", {
    sessionKey: "hermes:main:t1",
    limit: 2,
    beforeId: 7,
  });
  const c = calls[0];
  if (c.method !== LINK_DB_METHODS.chatHistory) throw new Error("wrong link method: " + c.method);
  if (c.params.beforeId !== 7) throw new Error("beforeId not passed: " + JSON.stringify(c.params));
  if (c.params.limit !== 2) throw new Error("limit not passed");
  if (res.hasMore !== true) throw new Error("hasMore not re-exported: " + JSON.stringify(res));
  if (res.nextBeforeId !== 3) throw new Error("nextBeforeId not re-exported");
  if (!Array.isArray(res.messages) || res.messages.length !== 2) throw new Error("messages lost");

  // legacy reply (no cursor fields) must not grow keys
  serverReply = {
    messages: serverReply.messages,
    sessionId: "tip1",
    total: 4,
  };
  calls.length = 0;
  const res2 = await bridge.request("chat.history", { sessionKey: "hermes:main:t1", limit: 2 });
  if (calls[0].params.beforeId !== undefined) throw new Error("beforeId leaked into legacy call");
  if ("hasMore" in res2 || "nextBeforeId" in res2) throw new Error("cursor keys leaked on legacy reply: " + JSON.stringify(res2));

  console.log("test_bridge_emu OK");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });

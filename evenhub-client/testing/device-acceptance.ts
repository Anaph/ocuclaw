import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import type { Question } from "../src/model";
import { workspaceFixture } from "./workspace-fixture";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const host = process.argv[2] ?? "127.0.0.1";
if (!isIP(host)) throw Error("Укажите IP-адрес компьютера");

const keyFile = process.env.OCUCLAW_QA_TLS_KEY;
const certFile = process.env.OCUCLAW_QA_TLS_CERT;
if (Boolean(keyFile) !== Boolean(certFile))
  throw Error("Для WSS нужны и ключ, и сертификат");

const https =
  keyFile && certFile
    ? { key: readFileSync(keyFile), cert: readFileSync(certFile) }
    : undefined;
const originHost = isIP(host) === 6 ? `[${host}]` : host;
const port = 5180;
const token = randomBytes(12).toString("hex");
const fixture = workspaceFixture(
  Array.from({ length: 5 }, (_, i) =>
    new Date(Date.now() + (i + 1) * 86400_000).toISOString(),
  ),
);
const app = await preview({
  root: fileURLToPath(new URL("../", import.meta.url)),
  preview: { host, port, strictPort: true, https },
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
let generation = 0;
function seed() {
  const now = Date.now();
  const run = ++generation;
  const questions = [
    {
      id: `qa-period-${run}`,
      sessionKey: "hermes:main:a",
      sessionTitle: "Отчёт",
      question: "Какой период использовать для проверки?",
      choices: ["Квартал", "Год"],
      expiresAtMs: now + 10 * 60_000,
    },
    {
      id: `qa-formats-${run}`,
      sessionKey: "hermes:main:b",
      sessionTitle: "Выгрузка",
      question: "В каких форматах подготовить отчёт?",
      choices: ["Текст", "Таблица", "PDF"],
      multiSelect: true,
      expiresAtMs: now + 15 * 60_000,
    },
    {
      id: `qa-permission-${run}`,
      sessionKey: "hermes:research:qa",
      sessionTitle: "Исследование",
      question: "Разрешить выполнение тестовой команды?",
      kind: "permission",
      allowedDecisions: ["allow-once", "deny"],
      permissionCommand: "git status --short",
      permissionDescription: "Безопасная тестовая команда. ".repeat(25),
      expiresAtMs: null,
    },
  ].map(
    (item): Question => ({
      agentName: "Hermes QA",
      allowOther: true,
      createdAtMs: now,
      ...item,
      kind: item.kind === "permission" ? "permission" : "question",
    }),
  );
  fixture.replacePending(questions);
  fixture.replaceCompleted([
    {
      id: `qa-result-${run}`,
      sessionKey: "hermes:main:a",
      sessionTitle: "Итог тестовой задачи",
      agentName: "Hermes QA",
      summary:
        "Тестовый отчёт готов.\n\n```text\nПроверка кириллицы и переноса длинных строк.\n```",
      createdAtMs: now,
      read: false,
    },
  ]);
  fixture.update();
}
seed();
app.httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/relay") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (peer: any) => {
    if (url.searchParams.get("token") !== token)
      return peer.close(4001, "Invalid QA token");
    fixture.attach({
      send: (text) => {
        if (peer.readyState === 1) peer.send(text);
      },
      close: ({ code, reason }) => peer.close(code, reason),
      onMessage: (handle) =>
        peer.on("message", (raw: Buffer) => {
          try {
            handle(raw);
          } catch {
            peer.close(1003, "Invalid QA frame");
          }
        }),
    });
  });
});

console.log(`QR: ${https ? "https" : "http"}://${originHost}:${port}/`);
console.log(
  `Адрес в OcuClaw: ${https ? "wss" : "ws"}://${originHost}:${port}/relay`,
);
console.log(`Тестовый ключ: ${token}`);
console.log(
  "Команды: seed, resolve, expire, drop-answer, drop-message, drop-job, fail-stt, status, quit",
);
const consoleInput = createInterface({ input: process.stdin });
consoleInput.on("line", (line) => {
  switch (line.trim()) {
    case "seed":
      seed();
      break;
    case "resolve":
      fixture.resolveExternal();
      fixture.update();
      break;
    case "expire":
      fixture.expirePending();
      fixture.update();
      break;
    case "drop-answer":
      fixture.dropNextReply("inbox.answer");
      break;
    case "drop-message":
      fixture.dropNextReply("agent");
      break;
    case "drop-job":
      fixture.dropNextReply("automations.create");
      break;
    case "fail-stt":
      fixture.replyNext("workspace.stt.transcribe", {
        success: false,
        error: "Сбой STT на стенде",
      });
      break;
    case "status":
      console.table(
        fixture.calls
          .filter(({ method }) =>
            /^(agent|inbox\.(answer|operation)|automations\.(create|receipt)|workspace.stt.transcribe)$/.test(
              method,
            ),
          )
          .map(({ method, params }) => ({
            method,
            id: params.id,
            operation: params.operationId || params.idempotencyKey,
            pcmBytes:
              method === "workspace.stt.transcribe"
                ? Buffer.from(params.wav || "", "base64").length - 44
                : undefined,
          })),
      );
      break;
    case "quit":
      consoleInput.close();
      break;
  }
});
consoleInput.on("close", () => {
  for (const peer of wss.clients) peer.terminate();
  wss.close();
  void app.close();
});

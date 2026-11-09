import type { Completion, Question } from "../src/model";

interface Peer {
  send: (text: string) => void;
  onMessage: (handler: (raw: string | Buffer) => void) => void;
  close: (options: { code: number; reason: string }) => unknown;
}

export function workspaceFixture(
  nextRuns = ["2026-11-10T09:00:00+03:00", "2026-11-11T09:00:00+03:00"],
) {
  const calls: any[] = [];
  const sendReceipts = new Map<string, any>();
  const scheduleReceipts = new Map<string, any>();
  const answerReceipts = new Map<string, any>();
  const nextReply = new Map<string, any>();
  const dropReplies = new Set<string>();
  let peer: Peer | undefined;
  let jobs: any[] = [];
  let completed: Completion[] = [];
  let pending: Question[] = [
    {
      id: "question-1",
      sessionKey: "hermes:main:b",
      sessionTitle: "Другой чат",
      agentName: "Hermes",
      kind: "question",
      question: "Какой период?",
      choices: ["Квартал", "Год"],
      multiSelect: false,
      allowOther: true,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 600000,
    },
  ];
  const sessions = [
    {
      key: "hermes:main:a",
      label: "Первый чат",
      preview: "Результат",
      agentStatus: { working: true },
      actions: { rename: true, pin: true, hide: true, stop: true },
    },
    {
      key: "hermes:main:b",
      label: "Другой чат",
      agentStatus: { needsYou: true },
      actions: { rename: true, pin: true, hide: true, stop: true },
    },
  ];
  let messages: any[] = [
    { id: 1, role: "user", content: "Подготовь отчёт" },
    {
      id: 2,
      role: "assistant",
      content:
        "## Отчёт\n```js\nconst ok = true;\n```\n<script>window.injected=true</script>",
    },
  ];
  const snapshot = () => ({
    version: 1,
    available: true,
    authorizedNamespaces: ["main", "research"],
    capabilities: {
      allGatewayQuestions: true,
      coverage: "gateway",
      permissions: "gateway",
    },
    pending,
    completed,
  });
  const options = {
    supported: true,
    serverNowMs: Date.now(),
    timezone: "Europe/Istanbul",
    missedPolicy: "Штатные правила Hermes",
    parallelPolicy: "Hermes",
    runNowPolicy: "Ближайший запуск переносится на сейчас",
    stopSupported: true,
  };
  function attach(socket: Peer) {
    peer = socket;
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "protocolHello") {
        socket.send(
          JSON.stringify({ type: "protocolHelloAck", protocolVersion: "v2" }),
        );
        return;
      }
      if (frame.type === "ping") return;
      calls.push(frame);
      const p = frame.params || {};
      let data: any = {};
      if (frame.method === "capabilities")
        data = {
          version: 1,
          chatStream: true,
          catalog: true,
          schedules: true,
          uploads: {
            fileBytes: 16777216,
            totalBytes: 33554432,
            chunkBytes: 65536,
            files: 8,
          },
        };
      if (["inbox.subscribe", "inbox.snapshot"].includes(frame.method))
        data = snapshot();
      if (frame.method === "inbox.completed")
        data = {
          items: completed.filter(
            (item) =>
              !p.id || (item.id === p.id && item.sessionKey === p.sessionKey),
          ),
        };
      if (frame.method === "inbox.read")
        completed = completed.map((item) =>
          item.id === p.id ? { ...item, read: true } : item,
        );
      if (frame.method === "workspace.catalog")
        data = {
          agents: [
            { id: "default", name: "Hermes" },
            { id: "research", name: "Исследователь" },
          ],
          models: [{ id: "model-a", provider: "custom", name: "Модель A" }],
        };
      if (frame.method === "sessions.list") data = { sessions };
      if (frame.method === "sessions.create")
        data = {
          key:
            p.profileId === "research"
              ? "hermes:research:new"
              : "hermes:main:new",
        };
      if (["chat.history", "chat.subscribe"].includes(frame.method))
        data = { messages, hasMore: false, nextBeforeId: null };
      if (frame.method === "agent") {
        data = nextReply.get("agent") ?? { status: "accepted", runId: "run-1" };
        if (data.status === "accepted")
          messages = [
            ...messages,
            { id: messages.length + 1, role: "user", content: p.message },
          ];
        sendReceipts.set(p.idempotencyKey, data);
      }
      if (frame.method === "workspace.send.receipt")
        data = sendReceipts.get(p.operationId) ?? { status: "not_found" };
      if (frame.method === "inbox.get") {
        const item = pending.find(
          (x) => x.id === p.id && x.sessionKey === p.sessionKey,
        );
        data = item
          ? item.expiresAtMs !== null && item.expiresAtMs <= Date.now()
            ? { status: "expired" }
            : { status: "pending", item }
          : { status: "already_answered" };
      }
      if (frame.method === "inbox.answer") {
        data = nextReply.get(frame.method) ?? { status: "accepted" };
        if (data.status === "accepted")
          pending = pending.filter((item) => item.id !== p.id);
        answerReceipts.set(p.operationId, data);
      }
      if (frame.method === "inbox.operation")
        data = answerReceipts.get(p.operationId) ?? { status: "not_found" };
      if (frame.method === "automations.options") data = options;
      if (frame.method === "jobs.list") data = { jobs };
      if (frame.method === "workspace.stt.providers")
        data = { providers: [{ id: "simulated", available: true }] };
      if (frame.method === "workspace.stt.transcribe")
        data =
          p.provider === "simulated"
            ? {
                success: true,
                transcript: "Каждый день в девять собирай сводку",
              }
            : { success: false, error: "Выберите провайдер распознавания" };
      if (frame.method === "automations.draft")
        data = {
          fields: {
            name: "Голосовая сводка",
            prompt: p.text,
            schedule: "0 9 * * *",
          },
        };
      if (frame.method === "automations.preview")
        data = {
          preview: {
            fields: p.fields,
            reviewHash: "a".repeat(64),
            timezone: "Europe/Istanbul",
            scheduleDisplay: p.fields.schedule,
            nextRuns,
          },
        };
      if (
        frame.method === "automations.create" &&
        !nextReply.has(frame.method)
      ) {
        jobs = [
          {
            id: "job-1",
            name: p.fields.name,
            state: "scheduled",
            schedule: p.fields.schedule,
            nextRunAt: nextRuns[0],
            fields: p.fields,
            revision: "b".repeat(64),
          },
        ];
        data = { status: "saved" };
      }
      if (frame.method === "automations.read") data = { job: jobs[0] };
      if (frame.method === "automations.receipt")
        data = scheduleReceipts.get(p.operationId) ?? { status: "not_found" };
      if (frame.method === "jobs.pause") {
        jobs[0].paused = true;
        data = { status: "applied" };
      }
      if (frame.method === "jobs.run") data = { status: "applied" };
      if (frame.method === "jobs.history")
        data = {
          history: [
            {
              id: "execution-1",
              jobId: "job-1",
              status: "completed",
              delivery: "not_configured",
              summary: "Задача выполнена",
              sessionKey: "hermes:main:x:cron:cron_test",
            },
          ],
        };
      if (frame.method === "uploads.begin")
        data = { id: "upload-1", chunkBytes: 65536 };
      if (frame.method === "uploads.chunk")
        data = {
          id: p.id,
          offset: p.offset + atob(p.content).length,
          complete: true,
        };
      if (nextReply.has(frame.method)) {
        data = nextReply.get(frame.method);
        nextReply.delete(frame.method);
      }
      if (frame.method === "automations.create")
        scheduleReceipts.set(p.operationId, data);
      if (dropReplies.delete(frame.method)) {
        void socket.close({ code: 1012, reason: "Simulated relay restart" });
        return;
      }
      socket.send(
        JSON.stringify({
          type: "ocuclaw.workspace.result",
          version: 1,
          id: frame.id,
          data,
        }),
      );
    });
  }
  return {
    attach,
    calls,
    replacePending: (items: typeof pending) => {
      pending = items;
    },
    replaceCompleted: (items: Completion[]) => {
      completed = items;
    },
    replyNext: (method: string, data: unknown) => nextReply.set(method, data),
    dropNextReply: (method: string) => dropReplies.add(method),
    resolveExternal: () => {
      pending = [];
    },
    expirePending: () => {
      pending = pending.map((item) => ({
        ...item,
        expiresAtMs: Date.now() - 1,
      }));
    },
    update: (patch: Partial<ReturnType<typeof snapshot>> = {}) =>
      peer?.send(
        JSON.stringify({
          type: "ocuclaw.workspace.changed",
          version: 1,
          data: { ...snapshot(), ...patch },
        }),
      ),
    emit: (event: string, data: any) =>
      peer?.send(
        JSON.stringify({
          type: "ocuclaw.workspace.chat",
          version: 1,
          event,
          data,
        }),
      ),
  };
}

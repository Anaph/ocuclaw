import { test, expect, type Page } from "@playwright/test";
async function server(page: Page) {
  const calls: any[] = [];
  let peer: any;
  let jobs: any[] = [];
  let pending = [
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
    completed: [],
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
  await page.routeWebSocket("ws://127.0.0.1:47801/**", (socket) => {
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
        messages = [...messages, { id: 3, role: "user", content: p.message }];
        data = { status: "accepted", runId: "run-1" };
      }
      if (frame.method === "inbox.get")
        data = pending.some((x) => x.id === p.id)
          ? { status: "pending", item: pending[0] }
          : { status: "already_answered" };
      if (frame.method === "inbox.answer") {
        pending = [];
        data = { status: "accepted" };
      }
      if (frame.method === "automations.options") data = options;
      if (frame.method === "jobs.list") data = { jobs };
      if (frame.method === "automations.preview")
        data = {
          preview: {
            fields: p.fields,
            reviewHash: "a".repeat(64),
            timezone: "Europe/Istanbul",
            scheduleDisplay: p.fields.schedule,
            nextRuns: [
              "2026-11-10T09:00:00+03:00",
              "2026-11-11T09:00:00+03:00",
            ],
          },
        };
      if (frame.method === "automations.create") {
        jobs = [
          {
            id: "job-1",
            name: p.fields.name,
            state: "scheduled",
            schedule: p.fields.schedule,
            nextRunAt: "2026-11-10T09:00:00+03:00",
            fields: p.fields,
            revision: "b".repeat(64),
          },
        ];
        data = { status: "saved" };
      }
      if (frame.method === "automations.read") data = { job: jobs[0] };
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
      socket.send(
        JSON.stringify({
          type: "ocuclaw.workspace.result",
          version: 1,
          id: frame.id,
          data,
        }),
      );
    });
  });
  return {
    calls,
    resolveExternal: () => {
      pending = [];
    },
    update: () =>
      peer.send(
        JSON.stringify({
          type: "ocuclaw.workspace.changed",
          version: 1,
          data: snapshot(),
        }),
      ),
    emit: (event: string, data: any) =>
      peer.send(
        JSON.stringify({
          type: "ocuclaw.workspace.chat",
          version: 1,
          event,
          data,
        }),
      ),
  };
}
async function connect(page: Page) {
  await page.goto("/?preview=1");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.locator("#phone-connect [name=url]").fill("ws://127.0.0.1:47801/");
  await page.locator("#phone-connect [name=token]").fill("key");
  await page
    .locator("#phone-connect")
    .getByRole("button", { name: "Подключить", exact: true })
    .click();
  await expect(page.locator("#phone-status")).toContainText("● Hermes");
}

test("phone without G2: streaming, draft, attachment upload, addressed Inbox and independent HUD", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { calls, emit } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: /Первый чат/ }).click();
  await expect(
    page.getByRole("heading", { name: "Отчёт", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Копировать", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  await page.getByLabel("Сообщение Hermes").fill("Черновик");
  emit("streaming", {
    sessionKey: "hermes:main:b",
    runId: "wrong",
    seq: 1,
    text: "Чужой ответ",
  });
  await expect(page.locator(".streaming")).toHaveCount(0);
  emit("streaming", {
    sessionKey: "hermes:main:a",
    runId: "run-1",
    seq: 1,
    text: "Новый ответ частями",
  });
  await expect(page.locator(".streaming")).toContainText("Новый ответ частями");
  await expect(page.getByLabel("Сообщение Hermes")).toHaveValue("Черновик");
  await page.getByRole("button", { name: "На очки", exact: true }).click();
  await expect(page.locator("#hud-panel #title")).toHaveText("Первый чат");
  await page.getByRole("button", { name: "‹ Чаты", exact: true }).click();
  await page
    .locator("#session-list button")
    .filter({ hasText: "Другой чат" })
    .click();
  await expect(page.locator("#hud-panel #title")).toHaveText("Первый чат");
  await expect(page.getByLabel("Сообщение Hermes")).toHaveValue("");
  await page.getByLabel("Сообщение Hermes").fill("Ответ с файлом");
  await page.locator("#files").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(180000, 65),
  });
  await expect(page.locator(".attachment")).toContainText("report.txt");
  await page
    .locator("#compose-chat")
    .getByRole("button", { name: "Отправить", exact: true })
    .click();
  await expect
    .poll(() => calls.filter((x) => x.method === "agent").length)
    .toBe(1);
  expect(calls.filter((x) => x.method === "uploads.chunk").length).toBe(3);
  expect(calls.find((x) => x.method === "agent").params.sessionKey).toBe(
    "hermes:main:b",
  );
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await page.locator("#inbox-list button").click();
  await page.getByRole("button", { name: "Квартал", exact: true }).click();
  expect(calls.filter((x) => x.method === "inbox.answer")).toHaveLength(0);
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect
    .poll(() => calls.filter((x) => x.method === "inbox.answer").length)
    .toBe(1);
  expect(calls.find((x) => x.method === "inbox.answer").params.sessionKey).toBe(
    "hermes:main:b",
  );
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/phone-inbox.png",
    fullPage: true,
  });
});

test("schedule uses server preview before save, native pause/run and execution history", async ({
  page,
}) => {
  const { calls } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await expect(page.locator("#phone-content")).toContainText("Europe/Istanbul");
  await page.getByRole("button", { name: "＋ Задача", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Утренний отчёт");
  await page
    .getByLabel("Инструкция и выбранный контекст")
    .fill("Подготовить отчёт");
  await page.locator("#schedule-kind").selectOption("weekly");
  await page.locator('[name=days][value="1"]').check();
  await page.locator('[name=days][value="5"]').check();
  await page.locator("[name=time]").fill("09:30");
  await page
    .getByRole("button", { name: "Проверить расписание", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ближайшие запуски по Hermes" }),
  ).toBeVisible();
  expect(calls.filter((x) => x.method === "automations.create")).toHaveLength(
    0,
  );
  expect(
    calls.find((x) => x.method === "automations.preview").params.fields
      .schedule,
  ).toBe("30 9 * * 1,5");
  await page
    .getByRole("button", { name: "Подтвердить и сохранить", exact: true })
    .click();
  await expect(page.locator("#job-list")).toContainText("Утренний отчёт");
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  expect(calls.filter((x) => x.method === "jobs.pause")).toHaveLength(0);
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Возобновить", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.locator("#execution-list")).toContainText(
    "Задача выполнена",
  );
  await page
    .getByRole("button", { name: "Открыть запуск", exact: true })
    .click();
  await expect
    .poll(
      () =>
        calls.filter((x) => x.method === "chat.subscribe").at(-1)?.params
          .sessionKey,
    )
    .toBe("hermes:main:x:cron:cron_test");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/phone-chat-mobile.png",
    fullPage: true,
  });
});

test("new chat keeps profile/model affinity and file-picker cancellation is harmless", async ({
  page,
}) => {
  const { calls } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "＋ Новый чат", exact: true }).click();
  await page.locator("#new-chat [name=profile]").selectOption("research");
  await page.locator("#new-chat [name=model]").selectOption("custom/model-a");
  await page.getByRole("button", { name: "Создать чат", exact: true }).click();
  await expect(page.getByLabel("Сообщение Hermes")).toBeVisible();
  expect(
    calls.find((x) => x.method === "sessions.create").params,
  ).toMatchObject({
    profileId: "research",
    model: "model-a",
    provider: "custom",
  });
  await page.locator("#files").setInputFiles([]);
  await expect(page.locator(".attachment")).toHaveCount(0);
  await page.getByLabel("Сообщение Hermes").fill("Только текст");
  await page
    .locator("#compose-chat")
    .getByRole("button", { name: "Отправить", exact: true })
    .click();
  await expect
    .poll(() => calls.filter((x) => x.method === "agent").length)
    .toBe(1);
  expect(calls.find((x) => x.method === "agent").params.sessionKey).toBe(
    "hermes:research:new",
  );
});

test("live inbox updates preserve schedule input and externally answered questions cannot be sent", async ({
  page,
}) => {
  const { calls, update, resolveExternal } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await page.getByRole("button", { name: "＋ Задача", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Черновик задачи");
  await page.locator("#schedule-kind").selectOption("weekly");
  await page.locator('[name=days][value="2"]').check();
  update();
  await expect(page.locator("#schedule-kind")).toHaveValue("weekly");
  await expect(page.locator('[name=days][value="2"]')).toBeChecked();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue(
    "Черновик задачи",
  );
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await page.locator("#inbox-list button").click();
  await page.getByRole("button", { name: "Квартал", exact: true }).click();
  resolveExternal();
  update();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#phone-notice")).toContainText("Ответ уже дан");
  expect(calls.filter((x) => x.method === "inbox.answer")).toHaveLength(0);
});

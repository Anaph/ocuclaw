import { test, expect } from "@playwright/test";

test("three sessions, explicit confirmation, voice-text address, external resolution and mobile layout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const far = Date.now() + 600000;
  let pending = [
    {
      id: "q1",
      sessionKey: "hermes:main:a",
      sessionTitle: "Доклад",
      agentName: "Исследование",
      kind: "question",
      question: "Какой период использовать для сравнения результатов?",
      choices: ["Последний месяц", "Последний квартал"],
      allowOther: true,
      multiSelect: false,
      expiresAtMs: far,
      createdAtMs: 1,
    },
    {
      id: "q2",
      sessionKey: "hermes:main:b",
      sessionTitle: "Исправление",
      agentName: "Код",
      kind: "question",
      question: "Какие проверки выполнить?",
      choices: ["Типы", "Тесты", "Сборка"],
      allowOther: true,
      multiSelect: true,
      expiresAtMs: far + 1,
      createdAtMs: 2,
    },
    {
      id: "q3",
      sessionKey: "hermes:main:c",
      sessionTitle: "Продажи",
      agentName: "Аналитика",
      kind: "question",
      question: "Какой источник использовать?",
      choices: [],
      allowOther: true,
      multiSelect: false,
      expiresAtMs: far + 2,
      createdAtMs: 3,
    },
  ];
  const answers: any[] = [],
    methods: string[] = [];
  let peer: any;
  const snapshot = () => ({
    version: 1,
    available: true,
    capabilities: {
      allGatewayQuestions: true,
      coverage: "gateway",
      permissions: "gateway",
    },
    pending,
    completed: [],
  });
  await page.routeWebSocket("ws://127.0.0.1:47801/**", (socket) => {
    peer = socket;
    socket.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "protocolHello") {
        socket.send(
          JSON.stringify({ type: "protocolHelloAck", protocolVersion: "v2" }),
        );
        return;
      }
      if (f.type === "ping") return;
      if (f.type !== "ocuclaw.workspace.request") return;
      methods.push(f.method);
      let data: any = {};
      if (f.method === "capabilities") data = { version: 1 };
      if (f.method === "inbox.subscribe" || f.method === "inbox.snapshot")
        data = snapshot();
      if (f.method === "inbox.get") {
        const item = pending.find(
          (x) => x.id === f.params.id && x.sessionKey === f.params.sessionKey,
        );
        data = item
          ? { status: "pending", item }
          : { status: "already_answered" };
      }
      if (f.method === "inbox.answer") {
        answers.push(f.params);
        pending = pending.filter((x) => x.id !== f.params.id);
        data = { status: "accepted" };
      }
      if (f.method === "sessions.list")
        data = {
          sessions: [
            {
              key: "hermes:main:a",
              label: "Доклад",
              agentStatus: { working: true },
              actions: { rename: true, stop: true, hide: true, pin: true },
            },
          ],
        };
      socket.send(
        JSON.stringify({
          type: "ocuclaw.workspace.result",
          version: 1,
          id: f.id,
          data,
        }),
      );
    });
  });
  await page.goto("/?preview=1&hud=1");
  await page.getByLabel("Адрес сервера").fill("ws://127.0.0.1:47801/");
  await page.getByLabel("Ключ подключения").fill("local-test-only");
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await page
    .getByRole("button", { name: "Нужен ответ · 3", exact: true })
    .click();
  await expect(page.locator("#actions button")).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/inbox-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "test-results/inbox-desktop.png",
    fullPage: true,
  });
  await page.locator("#actions button").first().click();
  await page
    .getByRole("button", { name: "Последний квартал", exact: true })
    .click();
  expect(answers).toHaveLength(0);
  await expect(page.locator("#title")).toHaveText("Подтверждение");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#title")).toHaveText("Ответ принят");
  expect(answers[0]).toMatchObject({
    id: "q1",
    sessionKey: "hermes:main:a",
    answer: { indices: [1] },
  });
  await page
    .getByRole("button", { name: "Следующий вопрос", exact: true })
    .click();
  await expect(page.locator("#title")).toHaveText("Код / Исправление");
  await page.getByRole("button", { name: "☐ Типы", exact: true }).click();
  await page.getByRole("button", { name: "☐ Сборка", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  expect(answers).toHaveLength(1);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await page.getByRole("button", { name: "К списку", exact: true }).click();
  await expect(page.locator("#title")).toHaveText("Нужен ответ · 1");
  expect(answers[1].answer.indices).toEqual([0, 2]);
  await page.locator("#actions button").first().click();
  await page
    .getByRole("button", { name: "Ответить голосом или текстом", exact: true })
    .click();
  await page.locator("#text").fill("Используй отчёт за октябрь");
  await page.locator("#text-form button").click();
  expect(answers).toHaveLength(2);
  // Desktop answers while wearer is confirming: no new response is issued.
  pending = [];
  peer.send(
    JSON.stringify({
      type: "ocuclaw.workspace.changed",
      version: 1,
      data: snapshot(),
    }),
  );
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#notice")).toHaveText("Вопрос уже закрыт");
  expect(answers).toHaveLength(2);
  expect(methods).not.toContain("sessions.switch");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Назад", exact: true }).click();
  await page.screenshot({
    path: "test-results/inbox-empty-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("session actions and completion read receipts are available without switching another client", async ({
  page,
}) => {
  const calls: any[] = [];
  let pinned = false,
    hidden = false,
    working = true;
  let completed = [
    {
      id: "r1",
      sessionKey: "hermes:main:a",
      agentName: "Код",
      sessionTitle: "Исправление",
      summary: "Все проверки прошли",
      read: false,
      createdAtMs: Date.now(),
    },
  ];
  const snapshot = () => ({
    version: 1,
    available: true,
    capabilities: { allGatewayQuestions: true, permissions: "gateway" },
    pending: [],
    completed,
    unreadCompleted: completed.filter((x) => !x.read).length,
  });
  await page.routeWebSocket("ws://127.0.0.1:47802/**", (socket) =>
    socket.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "protocolHello") {
        socket.send(
          JSON.stringify({ type: "protocolHelloAck", protocolVersion: "v2" }),
        );
        return;
      }
      if (f.type !== "ocuclaw.workspace.request") return;
      calls.push(f);
      let data: any = {};
      if (f.method === "capabilities") data = { version: 1 };
      if (f.method === "inbox.subscribe" || f.method === "inbox.snapshot")
        data = snapshot();
      if (f.method === "inbox.read") {
        completed[0].read = true;
        data = { status: "accepted" };
      }
      if (f.method === "sessions.list")
        data = {
          sessions: hidden
            ? []
            : [
                {
                  key: "hermes:main:a",
                  label: "Исправление",
                  pinned,
                  agentStatus: { working },
                  actions: { pin: true, rename: true, hide: true, stop: true },
                },
              ],
        };
      if (f.method === "chat.history")
        data = {
          messages: [{ id: 1, role: "assistant", content: "Работа готова" }],
          total: 1,
        };
      if (f.method === "sessions.pin") {
        pinned = f.params.pinned;
        data = { ok: true };
      }
      if (f.method === "sessions.abort")
        data = { status: "accepted", aborted: true };
      if (f.method === "sessions.patch") {
        hidden = f.params.hidden === true;
        data = { ok: true };
      }
      if (f.method === "sessions.create")
        data = { key: "hermes:main:new-session" };
      if (f.method === "agent") data = { status: "accepted", runId: "run-1" };
      socket.send(
        JSON.stringify({
          type: "ocuclaw.workspace.result",
          version: 1,
          id: f.id,
          data,
        }),
      );
    }),
  );
  await page.goto("/?preview=1&hud=1");
  await page.getByLabel("Адрес сервера").fill("ws://127.0.0.1:47802/");
  await page.getByLabel("Ключ подключения").fill("local-test-only");
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await page.getByRole("button", { name: "Готово · 1", exact: true }).click();
  await page.locator("#actions button").first().click();
  await page
    .getByRole("button", { name: "Отметить прочитанным", exact: true })
    .click();
  await expect(page.locator("#title")).toHaveText("Готово");
  expect(completed[0].read).toBe(true);
  await page.locator("#controls [data-input=back]").click();
  await page.getByRole("button", { name: "Сессии", exact: true }).click();
  await page
    .locator("#actions button")
    .filter({ hasText: "Исправление" })
    .click();
  await page
    .getByRole("button", { name: "Действия с сессией", exact: true })
    .click();
  await page.getByRole("button", { name: "Закрепить", exact: true }).click();
  expect(pinned).toBe(true);
  await page
    .getByRole("button", { name: "Действия с сессией", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Остановить задачу", exact: true })
    .click();
  expect(calls.filter((x) => x.method === "sessions.abort")).toHaveLength(0);
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#actions")).toContainText("Остановка запрошена");
  await page
    .locator("#actions button")
    .filter({ hasText: "Исправление" })
    .click();
  await page
    .getByRole("button", { name: "Действия с сессией", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Переименовать", exact: true })
    .click();
  await page.locator("#text").fill("Новая задача");
  await page.locator("#text-form button").click();
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#title")).toHaveText("hermes:main:a");
  expect(
    calls.some(
      (x) => x.method === "sessions.patch" && x.params.label === "Новая задача",
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Действия с сессией", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Скрыть из списка", exact: true })
    .click();
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#actions button")).toHaveCount(2);
  await page
    .getByRole("button", { name: "+ Новая сессия", exact: true })
    .click();
  await page.locator("#text").fill("Проверь репозиторий");
  await page.locator("#text-form button").click();
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("#title")).toHaveText("hermes:main:new-session");
  expect(
    calls.some(
      (x) =>
        x.method === "agent" &&
        x.params.sessionKey === "hermes:main:new-session",
    ),
  ).toBe(true);
  expect(calls.some((x) => x.method === "sessions.switch")).toBe(false);
});

test("switching VPS isolates cached results and each answer receipt is reconciled separately", async ({
  page,
}) => {
  const calls: { server: string; method: string }[] = [];
  const checked: string[] = [];
  await page.routeWebSocket("ws://127.0.0.1:47803/**", (socket) =>
    socket.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      const server = new URL(socket.url()).pathname;
      if (f.type === "protocolHello") {
        socket.send(
          JSON.stringify({ type: "protocolHelloAck", protocolVersion: "v2" }),
        );
        return;
      }
      if (f.type !== "ocuclaw.workspace.request") return;
      calls.push({ server, method: f.method });
      let data: any = {};
      if (f.method === "capabilities") data = { version: 1 };
      if (f.method === "inbox.subscribe")
        data = {
          version: 1,
          available: true,
          capabilities: { allGatewayQuestions: true },
          pending: [],
          completed:
            server === "/a"
              ? [
                  {
                    id: "secret",
                    sessionKey: "hermes:main:a",
                    agentName: "A",
                    sessionTitle: "Секрет сервера A",
                    summary: "Приватный результат A",
                    createdAtMs: Date.now(),
                    read: false,
                  },
                ]
              : [],
        };
      if (f.method === "inbox.operation") {
        checked.push(f.params.operationId);
        data = {
          status:
            f.params.operationId === "operation-b" ? "accepted" : "uncertain",
        };
      }
      if (f.method === "inbox.get") data = { status: "source_unavailable" };
      socket.send(
        JSON.stringify({
          type: "ocuclaw.workspace.result",
          version: 1,
          id: f.id,
          data,
        }),
      );
    }),
  );
  await page.goto("/?preview=1&hud=1");
  await page.evaluate(() =>
    sessionStorage.setItem(
      "ocuclaw.pendingOperation:" +
        encodeURIComponent("ws://127.0.0.1:47803/a"),
      JSON.stringify([
        { operationId: "operation-a", id: "q-a", sessionKey: "hermes:main:a" },
        { operationId: "operation-b", id: "q-b", sessionKey: "hermes:main:b" },
      ]),
    ),
  );
  await page.getByLabel("Адрес сервера").fill("ws://127.0.0.1:47803/a");
  await page.getByLabel("Ключ подключения").fill("test-a");
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(page.locator("#notice")).toContainText(
    "Предыдущая отправка ещё не подтверждена",
  );
  await expect(page.locator("#notice")).toContainText(
    "Предыдущий ответ принят Hermes",
  );
  expect(checked.sort()).toEqual(["operation-a", "operation-b"]);
  expect(
    await page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem(
          "ocuclaw.pendingOperation:" +
            encodeURIComponent("ws://127.0.0.1:47803/a"),
        ) || "[]",
      ).map((receipt: { operationId: string }) => receipt.operationId),
    ),
  ).toEqual(["operation-a"]);
  await page.getByRole("button", { name: "Готово · 1", exact: true }).click();
  await expect(page.locator("#actions")).toContainText("Секрет сервера A");
  await page.locator("#setup summary").click();
  await page.getByLabel("Адрес сервера").fill("ws://127.0.0.1:47803/b");
  await page.getByLabel("Ключ подключения").fill("test-b");
  await page.getByRole("button", { name: "Подключить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Готово · 0", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#actions")).not.toContainText("Секрет сервера A");
  expect(
    calls.filter((x) => x.server === "/b" && x.method === "inbox.operation"),
  ).toEqual([]);
});

import { test, expect, type Page } from "@playwright/test";
import type { Completion, Question } from "../src/model";
import { workspaceFixture } from "../testing/workspace-fixture";
async function server(page: Page) {
  const fixture = workspaceFixture();
  await page.routeWebSocket("ws://127.0.0.1:47801/**", fixture.attach);
  return fixture;
}
async function connect(page: Page) {
  await page.goto("/?preview=1");
  await fillPhoneConnection(page);
}
async function fillPhoneConnection(page: Page) {
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.locator("#phone-connect [name=url]").fill("ws://127.0.0.1:47801/");
  await page.locator("#phone-connect [name=token]").fill("key");
  await page
    .locator("#phone-connect")
    .getByRole("button", { name: "Подключить", exact: true })
    .click();
  await expect(page.locator("#phone-status")).toContainText("● Hermes");
}

test("reconfirming a G2 message after a lost acknowledgment checks the original receipt", async ({
  page,
}) => {
  const { calls, dropNextReply } = await server(page);
  await page.goto("/?preview=1&hud=1");
  await page.locator("#connect [name=url]").fill("ws://127.0.0.1:47801/");
  await page.locator("#connect [name=token]").fill("key");
  await page.locator("#connect button").click();
  await expect(page.locator("#connection")).toHaveText("VPS подключён");
  await page.getByRole("button", { name: "Сессии", exact: true }).click();
  await page.getByRole("button", { name: /Первый чат/ }).click();
  await page
    .getByRole("button", { name: "Написать / надиктовать", exact: true })
    .click();
  await page.locator("#text").fill("Подготовь один отчёт");
  const review = page.locator("#text-form button");
  const send = page.getByRole("button", { name: "Отправить", exact: true });
  await review.click();
  dropNextReply("agent");
  await send.click();
  await expect(page.locator("#notice")).toContainText("Соединение потеряно");
  await expect(page.locator("#connection")).toHaveText("VPS подключён", {
    timeout: 10000,
  });
  await page
    .getByRole("button", { name: "Изменить / перезаписать", exact: true })
    .click();
  await expect(page.locator("#text")).toHaveValue("Подготовь один отчёт");
  await review.click();
  await send.click();
  await expect(page.locator("#title")).toHaveText("hermes:main:a");
  const sends = calls.filter((call) => call.method === "agent");
  expect(sends).toHaveLength(1);
  expect(
    calls.find((call) => call.method === "workspace.send.receipt")?.params
      .operationId,
  ).toBe(sends[0].params.idempotencyKey);
});

test("an uncertain answer is looked up before another confirmation can dispatch it", async ({
  page,
}) => {
  const { calls, replyNext } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await page.locator("#inbox-list button").click();
  await page.getByRole("button", { name: "Квартал", exact: true }).click();
  const confirm = page.getByRole("button", {
    name: "Подтвердить",
    exact: true,
  });
  replyNext("inbox.answer", { status: "uncertain" });
  await confirm.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Отправка не подтверждена",
  );
  replyNext("inbox.operation", { status: "not_found" });
  await page
    .getByRole("button", { name: "Проверить отправку", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Повторить отправку", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () => calls.filter((call) => call.method === "inbox.operation").length,
    )
    .toBe(1);
  const answers = calls.filter((call) => call.method === "inbox.answer");
  expect(answers).toHaveLength(1);
  expect(
    calls.find((call) => call.method === "inbox.operation")?.params.operationId,
  ).toBe(answers[0].params.operationId);
});

test("a rejected send receipt survives a socket restart and releases the draft for a new operation", async ({
  page,
}) => {
  const { calls, replyNext, dropNextReply, emit } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: /Первый чат/ }).click();
  const composer = page.getByLabel("Сообщение Hermes");
  const send = page
    .locator("#compose-chat")
    .getByRole("button", { name: "Отправить", exact: true });
  await composer.fill("Проверка обрыва");
  replyNext("agent", { status: "rejected", error: "Hermes отклонил запрос" });
  dropNextReply("agent");
  await send.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Соединение потеряно",
  );
  await expect(page.locator("#phone-status")).toContainText("● Hermes", {
    timeout: 10000,
  });
  await expect
    .poll(
      () => calls.filter((frame) => frame.method === "chat.subscribe").length,
    )
    .toBe(2);
  await expect(composer).toHaveValue("Проверка обрыва");
  const check = page.getByRole("button", {
    name: "Проверить отправку",
    exact: true,
  });
  await check.click();
  await expect(check).toHaveCount(0);
  expect(calls.filter((frame) => frame.method === "agent")).toHaveLength(1);
  await send.click();
  await expect(composer).toHaveValue("");
  const sends = calls.filter((frame) => frame.method === "agent");
  expect(sends).toHaveLength(2);
  expect(sends[1].params.idempotencyKey).not.toBe(
    sends[0].params.idempotencyKey,
  );
  emit("streaming", {
    sessionKey: "hermes:main:a",
    runId: "after-reconnect",
    seq: 1,
    text: "Поток восстановлен",
  });
  await expect(page.locator(".streaming")).toContainText("Поток восстановлен");
});

test("a rejected schedule mutation can be corrected and submitted as a new operation", async ({
  page,
}) => {
  const { calls, replyNext } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await page.getByRole("button", { name: "＋ Задача", exact: true }).click();
  const name = page.getByLabel("Название", { exact: true });
  await name.fill("Сводка");
  await page
    .getByLabel("Инструкция и выбранный контекст")
    .fill("Собрать данные");
  const preview = page.getByRole("button", {
    name: "Проверить расписание",
    exact: true,
  });
  const save = page.getByRole("button", {
    name: "Подтвердить и сохранить",
    exact: true,
  });
  await preview.click();
  replyNext("automations.create", {
    status: "rejected",
    error: "preview_expired",
  });
  await save.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Расписание проверено заново",
  );
  expect(
    calls.filter((frame) => frame.method === "automations.create"),
  ).toHaveLength(1);
  expect(
    calls.filter((frame) => frame.method === "automations.preview"),
  ).toHaveLength(2);
  await name.fill("Новая сводка");
  await preview.click();
  await save.click();
  await expect(page.locator("#job-list")).toContainText("Новая сводка");
  const mutations = calls.filter(
    (frame) => frame.method === "automations.create",
  );
  expect(mutations).toHaveLength(2);
  expect(mutations[0].params.operationId).not.toBe(
    mutations[1].params.operationId,
  );
});

test("a saved schedule clears its restored draft even when the HUD already checked the shared receipt", async ({
  page,
}) => {
  const { calls, dropNextReply } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await page.getByRole("button", { name: "＋ Задача", exact: true }).click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Один запуск операции");
  await page
    .getByLabel("Инструкция и выбранный контекст")
    .fill("Собрать данные");
  await page
    .getByRole("button", { name: "Проверить расписание", exact: true })
    .click();
  const save = page.getByRole("button", {
    name: "Подтвердить и сохранить",
    exact: true,
  });
  dropNextReply("automations.create");
  await save.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Соединение потеряно",
  );
  await expect(page.locator("#phone-status")).toContainText("● Hermes", {
    timeout: 10000,
  });
  await expect(save).toHaveCount(0);
  const check = page.getByRole("button", {
    name: "Проверить сохранение",
    exact: true,
  });
  await expect(check).toBeVisible();
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("ocuclaw.scheduleOperation:"))
        localStorage.removeItem(key);
  });
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  const newJob = page.getByRole("button", { name: "＋ Задача", exact: true });
  await newJob.click();
  await expect(page.locator("#job-name")).toHaveValue("Один запуск операции");
  await expect(save).toHaveCount(0);
  await check.click();
  await expect(page.locator("#phone-notice")).toContainText("Сохранено");
  await expect(
    page.getByRole("heading", { name: "Один запуск операции", exact: true }),
  ).toHaveCount(1);
  const creates = calls.filter(
    (frame) => frame.method === "automations.create",
  );
  expect(creates).toHaveLength(1);
  const receipt = calls.find((frame) => frame.method === "automations.receipt");
  expect(receipt.params.operationId).toBe(creates[0].params.operationId);
  await newJob.click();
  await expect(page.getByLabel("Название", { exact: true })).toHaveValue("");
});

async function simulateG2(page: Page, phone = false) {
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
        import { Glasses } from "/src/glasses.ts";
        import { Relay } from "/src/transport.ts";
        import { InboxModel } from "/src/model.ts";
        import { mountHud } from "/src/hud.ts";
        import { PhoneApp } from "/src/phone.ts";
        import "/src/style.css";
        const simulated = window.simulatedG2 = { tiles: {}, audio: [], exits: [], shown: [] };
        const captions = new WeakMap();
        const fill = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
          if (this.canvas.width === 576 && this.canvas.height === 288) {
            if (!captions.has(this.canvas)) captions.set(this.canvas, []);
            captions.get(this.canvas).push(text);
          }
          return fill.call(this, text, x, y, ...rest);
        };
        const drawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
          if (this.canvas.width === 288 && this.canvas.height === 144)
            captions.set(this.canvas, captions.get(source));
          return drawImage.call(this, source, ...args);
        };
        const toBlob = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
          return toBlob.call(this, blob => {
            if (blob && captions.has(this)) captions.set(blob, captions.get(this));
            callback(blob);
          }, ...args);
        };
        const arrayBuffer = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function() {
          const bytes = await arrayBuffer.call(this);
          if (captions.has(this)) captions.set(bytes, captions.get(this));
          return bytes;
        };
        const bridge = {
          createStartUpPageContainer: async () => ${phone ? 1 : 0},
          getLocalStorage: async () => "",
          setLocalStorage: async () => true,
          onEvenHubEvent: listener => {
            simulated.emit = listener;
            return () => {};
          },
          updateImageRawData: async ({ containerID, imageData }) => {
            if (simulated.block) await new Promise(resolve => { simulated.release = resolve; });
            simulated.tiles[containerID] = Array.from(new Uint8Array(imageData).slice(0, 8));
            if (containerID === 13) simulated.shown = captions.get(imageData.buffer) || [];
            return "success";
          },
          shutDownPageContainer: async (mode) => {
            simulated.exits.push(mode);
            return true;
          },
          audioControl: async (open, source) => {
            simulated.audio.push({ open, source });
            return true;
          },
        };
        const root = document.querySelector("#app");
        const relay = new Relay();
        const glasses = new Glasses(async () => bridge);
        const inbox = new InboxModel();
        const hudRoot = document.createElement("section");
        hudRoot.id = "hud-panel";
        hudRoot.hidden = ${phone};
        root.append(hudRoot);
        const hud = mountHud(relay, glasses, inbox, hudRoot);
        if (${phone}) {
          const phoneRoot = document.createElement("section");
          root.prepend(phoneRoot);
          new PhoneApp(phoneRoot, relay, glasses, inbox, hud, hudRoot);
        }
      `,
    }),
  );
  await page.goto(phone ? "/" : "/?hud=1");
  const hud = page.locator("#hud-panel");
  if (phone) await fillPhoneConnection(page);
  else {
    await hud.locator("#connect [name=url]").fill("ws://127.0.0.1:47801/");
    await hud.locator("#connect [name=token]").fill("key");
    await hud.locator("#connect button").click();
    await expect(hud.locator("#connection")).toHaveText("VPS подключён");
  }
  const event = (data: unknown) =>
    page.evaluate((event) => (window as any).simulatedG2.emit(event), data);
  const ring = (eventType = 0) =>
    event({ sysEvent: { eventSource: 2, eventType } });
  const shown = (text: string) =>
    expect
      .poll(() =>
        page.evaluate(() => (window as any).simulatedG2.shown.join("\n")),
      )
      .toContain(text);
  return { hud, event, ring, shown };
}

test("phone without G2 picks an available Hermes STT provider and keeps the draft editable", async ({
  page,
}) => {
  const { calls, replyNext } = await server(page);
  const { event } = await simulateG2(page, true);
  await page
    .getByRole("navigation", { name: "Разделы" })
    .getByRole("button", { name: "Чаты" })
    .click();
  await page.getByRole("button", { name: /Первый чат/ }).click();
  await page.locator("#message-input").fill("Черновик");
  await page.locator("#dictate").click();
  await expect(page.locator("#dictate")).toHaveText("Завершить диктовку");
  await event({ audioEvent: { audioPcm: [1, 2, 3, 4] } });
  replyNext("workspace.stt.providers", {
    providers: [
      { id: "offline", available: false },
      { id: "simulated", available: true },
    ],
  });
  await page.locator("#dictate").click();
  await expect(page.locator("#message-input")).toHaveValue(
    "Черновик\nКаждый день в девять собирай сводку",
  );
  const stt = calls.find(({ method }) => method === "workspace.stt.transcribe");
  expect(stt?.params).toMatchObject({ provider: "simulated", language: "ru" });
  expect(Buffer.from(stt.params.wav, "base64").subarray(44)).toEqual(
    Buffer.from([1, 2, 3, 4]),
  );
  expect(calls.some(({ method }) => method === "agent")).toBe(false);
});

test("R1 dictates and confirms a schedule, then recovers a lost save acknowledgment", async ({
  page,
}) => {
  const { calls, replyNext, dropNextReply } = await server(page);
  const { hud, event, ring, shown } = await simulateG2(page);
  await event({ menuItemClickEvent: { itemID: 104 } });
  await expect(
    hud.getByRole("button", { name: "+ Новая задача голосом" }),
  ).toBeEnabled();
  await shown("> + Новая задача голосом");
  await ring();
  await expect(hud.locator("#title")).toHaveText("Новая задача по расписанию");
  await shown("> Надиктовать");
  await ring();
  await expect(hud.locator("#title")).toHaveText("Слушаю…");
  await ring(3);
  await shown("> Надиктовать");
  expect(calls.some((call) => call.method === "workspace.stt.transcribe")).toBe(
    false,
  );
  await ring();
  await expect(hud.locator("#title")).toHaveText("Слушаю…");
  await event({ audioEvent: { audioPcm: [1, 2, 3, 4] } });
  await shown("> Завершить запись");
  replyNext("workspace.stt.transcribe", {
    success: false,
    error: "Распознавание временно недоступно",
  });
  await ring();
  await shown("> Повторить распознавание");
  await ring();
  await expect(hud.locator("#text")).toHaveValue(
    "Каждый день в девять собирай сводку",
  );
  const audio = await page.evaluate(() => (window as any).simulatedG2.audio);
  expect(audio.map((entry: { open: boolean }) => entry.open)).toEqual([
    true,
    false,
    true,
    false,
  ]);
  const stt = calls.filter(
    (call) => call.method === "workspace.stt.transcribe",
  );
  expect(stt).toHaveLength(2);
  expect(stt[1].params.wav).toBe(stt[0].params.wav);
  expect([...Buffer.from(stt[0].params.wav, "base64").subarray(44)]).toEqual([
    1, 2, 3, 4,
  ]);
  const taskName =
    "Голосовая сводка по всем отделам и дополнительным проектам с расшифровкой итогов";
  replyNext("automations.draft", {
    fields: { name: taskName, prompt: "Собрать сводку", schedule: "0 9 * * *" },
  });
  await shown("> Продолжить с текстом");
  await ring();
  await expect(hud.locator("#body")).toContainText("Europe/Istanbul");
  expect(
    (await hud.locator("#body").textContent())?.split("\n").slice(0, 2),
  ).toEqual([taskName, "Ближайший запуск: 2026-11-10 09:00:00+03:00"]);
  await expect(
    hud.getByRole("button", { name: "Создать задачу", exact: true }),
  ).toBeEnabled();
  expect(
    calls.filter((call) => call.method === "automations.create"),
  ).toHaveLength(0);
  await expect
    .poll(() =>
      page.evaluate(() => Object.keys((window as any).simulatedG2.tiles)),
    )
    .toEqual(["10", "11", "12", "13"]);
  const signature = await page.evaluate(
    () => (window as any).simulatedG2.tiles[10],
  );
  expect(signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  await hud
    .locator("#display")
    .screenshot({ path: "test-results/g2-schedule-simulation.png" });
  await shown("> Создать задачу");
  await shown("Ближайший запуск: 2026-11-10 09:00:00+03:00");
  dropNextReply("automations.create");
  await page.waitForTimeout(250);
  await ring();
  await shown("> Проверить сохранение");
  await expect(hud.locator("#connection")).toHaveText("VPS подключён", {
    timeout: 10000,
  });
  await ring(3);
  await shown("Сохранение задачи");
  await shown("> Проверить сохранение");
  await ring();
  await shown("Подтверждение");
  await shown("> Проверить сохранение");
  await ring();
  await shown("Задача сохранена");
  await expect(
    hud.getByRole("button", { name: /Голосовая сводка/ }),
  ).toBeVisible();
  const creates = calls.filter((call) => call.method === "automations.create");
  expect(creates).toHaveLength(1);
  expect(creates[0].params.reviewHash).toBe("a".repeat(64));
  expect(
    calls.find((call) => call.method === "automations.receipt")?.params
      .operationId,
  ).toBe(creates[0].params.operationId);
});

test("R1 shows the exact answer and checks an unconfirmed operation before retrying", async ({
  page,
}) => {
  const { calls, replyNext, replacePending } = await server(page);
  const start = Date.now();
  replacePending([
    {
      id: "question-1",
      sessionKey: "hermes:main:b",
      sessionTitle: "Другой чат",
      agentName: "Hermes",
      kind: "question",
      question: "Какой период?",
      choices: ["Квартал"],
      createdAtMs: start,
      expiresAtMs: start + 60000,
    },
    {
      id: "question-2",
      sessionKey: "hermes:main:a",
      sessionTitle: "Следующая сессия",
      agentName: "Hermes",
      kind: "question",
      question: "Какой формат?",
      choices: ["PDF"],
      createdAtMs: start,
      expiresAtMs: start + 120000,
    },
  ]);
  const { hud, ring, shown } = await simulateG2(page);
  await shown("> Нужен ответ · 2");
  await ring();
  await shown("> Hermes / Другой чат");
  await ring();
  await shown("> Квартал");
  await page.evaluate(() => {
    (window as any).simulatedG2.block = true;
  });
  await ring();
  await ring();
  await expect(hud.locator("#title")).toHaveText("Подтверждение");
  expect(calls.filter((call) => call.method === "inbox.answer")).toHaveLength(
    0,
  );
  await page.evaluate(() => {
    const g2 = (window as any).simulatedG2;
    g2.block = false;
    g2.release?.();
  });
  await shown("«Квартал»");
  await hud
    .locator("#display")
    .screenshot({ path: "test-results/g2-answer-simulation.png" });
  replyNext("inbox.answer", { status: "uncertain" });
  await page.waitForTimeout(250);
  await ring();
  await shown("Отправка не подтверждена");
  await shown("> Проверить отправку");
  replyNext("inbox.operation", { status: "not_found" });
  await ring();
  await shown("> Повторить отправку");
  expect(calls.filter((call) => call.method === "inbox.answer")).toHaveLength(
    1,
  );
  replyNext("inbox.operation", { status: "not_found" });
  await page.waitForTimeout(250);
  await ring();
  await shown("Ответ принят");
  const answers = calls.filter((call) => call.method === "inbox.answer");
  expect(answers).toHaveLength(2);
  expect(answers[1].params).toEqual(answers[0].params);
  await shown("> Следующий вопрос");
  await ring();
  await shown("Hermes / Следующая сессия");
  await shown("> PDF");
  expect(calls.filter((call) => call.method === "inbox.answer")).toHaveLength(
    2,
  );
});

test("R1 reads long permission context, cancels, then uses the system exit at the root", async ({
  page,
}) => {
  const fixture = await server(page);
  const permission: Question = {
    id: "permission",
    sessionKey: "hermes:main:b",
    sessionTitle: "Разрешение",
    agentName: "Hermes",
    kind: "permission",
    question: "Команда агента. ".repeat(45),
    choices: [],
    multiSelect: false,
    allowOther: false,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60000,
    allowedDecisions: ["allow-once", "deny"],
    permissionCommand: "git status --short",
    permissionDescription: "Подробности запроса. ".repeat(60),
  };
  fixture.replacePending([permission]);
  const { ring, shown } = await simulateG2(page);
  await shown("> Нужен ответ · 1");
  await ring();
  await shown("> Hermes / Разрешение");
  await ring();
  await shown("> Разрешить один раз");
  await ring(2);
  await shown("> Отклонить");
  await ring(2);
  await shown("> Полный текст вопроса");
  await ring();
  await shown("Текст · 1/");
  fixture.replacePending([
    permission,
    {
      id: "new-question",
      sessionKey: "hermes:main:a",
      sessionTitle: "Первый чат",
      agentName: "Hermes",
      kind: "question",
      question: "Новый запрос",
      createdAtMs: Date.now(),
      expiresAtMs: null,
    },
  ]);
  fixture.update();
  await ring(2);
  await shown("Текст · 2/");
  await ring(3);
  await shown("> Полный текст вопроса");
  await ring(1);
  await shown("> Отклонить");
  await ring(1);
  await shown("> Разрешить один раз");
  await ring();
  await shown("«Разрешить один раз»");
  await shown("git status --short");
  await ring(3);
  await shown("> Разрешить один раз");
  await ring(3);
  await shown("Новый вопрос · Hermes");
  await ring(3);
  await shown("Нужен ответ · 2");
  await ring(3);
  await shown("OcuClaw");
  await ring(3);
  await expect
    .poll(() => page.evaluate(() => (window as any).simulatedG2.exits))
    .toEqual([1]);
  expect(
    fixture.calls.filter((call) => call.method === "inbox.answer"),
  ).toHaveLength(0);
});

test("R1 recovers a committed answer after the link drops without resending", async ({
  page,
}) => {
  const fixture = await server(page);
  const { hud, ring, shown } = await simulateG2(page);
  await shown("> Нужен ответ · 1");
  await ring();
  await shown("> Hermes / Другой чат");
  await ring();
  await shown("> Квартал");
  await ring();
  await shown("«Квартал»");
  fixture.dropNextReply("inbox.answer");
  await page.waitForTimeout(250);
  await ring();
  await shown("> Проверить отправку");
  await expect(hud.locator("#connection")).toHaveText("VPS подключён", {
    timeout: 10000,
  });
  await shown("Предыдущий ответ принят Hermes");
  await ring();
  await shown("Ответ принят");
  expect(
    fixture.calls.filter((call) => call.method === "inbox.answer"),
  ).toHaveLength(1);
});

test("R1 pages a long selected answer and refuses to send after its deadline", async ({
  page,
}) => {
  const fixture = await server(page);
  fixture.replacePending([
    {
      id: "question-1",
      sessionKey: "hermes:main:b",
      sessionTitle: "Другой чат",
      agentName: "Hermes",
      kind: "question",
      question: "Какой период?",
      choices: [
        "Последний квартал. " + "Проверить каждую запись отдельно. ".repeat(40),
      ],
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 600000,
    },
  ]);
  const { ring, shown } = await simulateG2(page);
  await shown("> Нужен ответ · 1");
  await ring();
  await shown("> Hermes / Другой чат");
  await ring();
  await shown("> Последний квартал");
  await ring();
  await shown("«Последний квартал");
  await ring(2);
  await shown("> Прочитать полностью");
  await ring();
  await shown("Текст · 1/");
  await ring(2);
  await shown("Текст · 2/");
  await ring(3);
  await shown("> Прочитать полностью");
  await ring(1);
  await shown("> Отправить");
  await page.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 11 * 60 * 1000;
  });
  await page.waitForTimeout(250);
  await ring();
  await shown("Время ответа истекло");
  expect(
    fixture.calls.filter((call) => call.method === "inbox.answer"),
  ).toHaveLength(0);
});

test("phone restores a schedule draft and marks cached Inbox questions during source loss", async ({
  page,
}) => {
  const fixture = await server(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await connect(page);
  const schedule = page.getByRole("button", {
    name: "Расписание",
    exact: true,
  });
  const newJob = page.getByRole("button", { name: "＋ Задача", exact: true });
  const name = page.locator("#job-name");
  const prompt = page.locator("#job-prompt");
  await schedule.click();
  await newJob.click();
  await name.fill("Черновик по расписанию");
  await prompt.fill("Собрать отчёт");
  await schedule.click();
  await expect(name).toHaveValue("Черновик по расписанию");
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await expect(page.locator(".inbox-badge")).toHaveText("1");
  await expect(page.locator("#inbox-list")).toContainText("Осталось");
  fixture.update({ available: false, pending: [] });
  await expect(page.locator(".inbox-unavailable")).toContainText(
    "Источник вопросов недоступен",
  );
  await expect(page.locator("#inbox-list")).toContainText("Ждёт сверки");
  await expect(page.locator("#pending")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await schedule.click();
  await expect(prompt).toHaveValue("Собрать отчёт");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await connect(page);
  await schedule.click();
  await newJob.click();
  await expect(name).toHaveValue("Черновик по расписанию");
  await expect(prompt).toHaveValue("Собрать отчёт");
  await expect(page.locator("#schedule-preview")).toBeEmpty();
  await page.getByRole("button", { name: "‹ Расписание", exact: true }).click();
  await page.locator("#job-profile").selectOption("research");
  await newJob.click();
  await expect(name).toHaveValue("");
});

test("phone keeps the composer visible, anchors older history, and leaves reading position during streaming", async ({
  page,
}) => {
  const fixture = await server(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await connect(page);
  const row = (id: number) => ({
    id,
    role: "assistant",
    content: `Сообщение ${id}. ` + "Текст отчёта. ".repeat(16),
  });
  fixture.replyNext("chat.subscribe", {
    messages: Array.from({ length: 14 }, (_, i) => row(i + 11)),
    total: 24,
  });
  await page.getByRole("button", { name: /Первый чат/ }).click();
  const composer = page.locator("#message-input");
  const send = page.locator("#compose-chat [type=submit]");
  await expect(composer).toBeInViewport();
  await expect(send).toBeInViewport();
  await page.screenshot({ path: "test-results/phone-chat-layout.png" });
  const log = page.locator(".messages");
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  fixture.replyNext("chat.history", {
    messages: Array.from({ length: 10 }, (_, i) => row(i + 1)),
    hasMore: false,
  });
  const anchor = page.locator('[data-message-id="11"]');
  const offset = async () =>
    (await anchor.boundingBox())!.y - (await log.boundingBox())!.y;
  const before = await offset();
  await page.getByRole("button", { name: "Предыдущие сообщения" }).click();
  await expect(page.locator('[data-message-id="1"]')).toHaveCount(1);
  expect(Math.abs((await offset()) - before)).toBeLessThanOrEqual(2);
  await composer.fill("Мой черновик");
  const position = await log.evaluate((element) => element.scrollTop);
  fixture.emit("streaming", {
    sessionKey: "hermes:main:a",
    runId: "one",
    seq: 1,
    text: "Продолжаю отчёт",
  });
  await expect(page.locator(".streaming")).toContainText("Продолжаю отчёт");
  await expect(composer).toBeFocused();
  expect(await log.evaluate((element) => element.scrollTop)).toBe(position);
  await expect(page.getByRole("button", { name: /К новым/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 500 });
  await expect(send).toBeInViewport();
});

test("the phone exposes chat actions on a narrow screen and scopes context and questions to the chat", async ({
  page,
}) => {
  const fixture = await server(page);
  fixture.replacePending(
    ["a", "b"].map((key) => ({
      id: `q-${key}`,
      sessionKey: `hermes:main:${key}`,
      sessionTitle: key === "a" ? "Первый чат" : "Другой чат",
      question: `Вопрос ${key}`,
      kind: "question",
      agentName: "Hermes",
      createdAtMs: Date.now(),
      expiresAtMs: null,
    })),
  );
  await page.setViewportSize({ width: 320, height: 720 });
  await connect(page);
  await page.getByRole("button", { name: /Первый чат/ }).click();
  const menu = page.locator(".chat-more summary");
  await expect(menu).toBeInViewport();
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Переименовать", exact: true }),
  ).toBeInViewport();
  await page
    .getByRole("button", { name: "Выбрать контекст задачи", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "В расписание · 0", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("В контекст задачи", { exact: true }).first().check();
  await expect(
    page.getByRole("button", { name: "В расписание · 1", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "‹ Чаты", exact: true }).click();
  await page.getByRole("button", { name: /Другой чат/ }).click();
  await expect(
    page.getByLabel("В контекст задачи", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Вопросы сессии", exact: true })
    .click();
  await expect(page.locator("#inbox-list")).toContainText("Вопрос b");
  await expect(page.locator("#inbox-list")).not.toContainText("Вопрос a");
  await page.getByRole("button", { name: "Все сессии", exact: true }).click();
  await expect(page.locator("#inbox-list")).toContainText("Вопрос a");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
});

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

test("a G2 handoff survives reopening and loads the exact question or older result", async ({
  page,
}) => {
  const fixture = await server(page);
  const older: Completion = {
    id: "older-result",
    sessionKey: "hermes:main:a",
    sessionTitle: "Отчёт за октябрь",
    agentName: "Hermes",
    summary: "Итог именно выбранного запуска",
    read: false,
    createdAtMs: Date.now() - 60_000,
  };
  const latest: Completion = {
    ...older,
    id: "latest-result",
    sessionKey: "hermes:main:b",
    sessionTitle: "Другой результат",
    summary: "Свежий отчёт",
    createdAtMs: Date.now(),
  };
  fixture.replaceCompleted([latest, older]);
  await connect(page);
  const hud = page.locator("#hud-panel");
  const tabs = page.getByRole("navigation", { name: "Разделы" });
  const revealHUD = async () => {
    await tabs.getByRole("button", { name: "Настройки", exact: true }).click();
    await page.locator("#hud-toggle").click();
    await expect(hud).toBeVisible();
  };
  await tabs.getByRole("button", { name: "Входящие", exact: true }).click();
  await page.locator("#inbox-list button").click();
  await page
    .locator("#question-links")
    .getByRole("button", { name: "На очки", exact: true })
    .click();
  await revealHUD();
  await hud.getByRole("button", { name: "На телефон", exact: true }).click();
  await expect(page.locator("#phone-handoff")).toContainText("Другой чат");
  await connect(page);
  await page
    .getByRole("button", { name: "Открыть на телефоне", exact: true })
    .click();
  await expect(page.locator("#phone-content")).toContainText("Какой период?");
  expect(
    fixture.calls.filter((call) => call.method === "inbox.get").at(-1)?.params,
  ).toEqual({ id: "question-1", sessionKey: "hermes:main:b" });
  expect(
    fixture.calls.filter((call) => call.method === "inbox.answer"),
  ).toHaveLength(0);

  await page.locator("#question-back").click();
  await page.locator("#completed").click();
  await page
    .locator("#inbox-list article")
    .filter({ hasText: older.sessionTitle })
    .getByRole("button", { name: "На очки", exact: true })
    .click();
  await revealHUD();
  await hud.getByRole("button", { name: "На телефон", exact: true }).click();
  fixture.replaceCompleted([latest]);
  await connect(page);
  fixture.replyNext("inbox.completed", { items: [older] });
  await page
    .getByRole("button", { name: "Открыть на телефоне", exact: true })
    .click();
  await expect(page.locator("#phone-content")).toContainText(older.summary);
  await expect(page.locator("#phone-content")).not.toContainText(
    latest.summary,
  );
  expect(
    fixture.calls.filter((call) => call.method === "inbox.completed").at(-1)
      ?.params,
  ).toEqual({ id: older.id, sessionKey: older.sessionKey });
});

test("phone gathers unresolved receipts for the active server and verifies without resending", async ({
  page,
}) => {
  const fixture = await server(page);
  await connect(page);
  await page.evaluate(() => {
    const scope = encodeURIComponent("ws://127.0.0.1:47801/");
    const send = (scope: string, key: string, id: string) =>
      localStorage.setItem(
        `ocuclaw.send:${scope}:${encodeURIComponent(key)}`,
        JSON.stringify({ id, text: "Черновик" }),
      );
    send(scope, "hermes:main:a", "message-op");
    send(encodeURIComponent("ws://other.test/"), "hermes:main:a", "other-op");
    sessionStorage.setItem(
      `ocuclaw.pendingOperation:${scope}`,
      JSON.stringify([
        {
          id: "question-1",
          sessionKey: "hermes:main:b",
          operationId: "answer-op",
        },
      ]),
    );
    localStorage.setItem(
      `ocuclaw.scheduleOperation:${scope}:research`,
      JSON.stringify({
        operationId: "job-op",
        operation: "jobs.run",
        params: { jobId: "job-a" },
      }),
    );
  });
  await page
    .getByRole("button", { name: "Нужна проверка · 3", exact: true })
    .click();
  const center = page.locator("#verification-list");
  await expect(center.locator("article")).toHaveCount(3);
  fixture.replyNext("workspace.send.receipt", { status: "accepted" });
  await center
    .locator("article")
    .filter({ hasText: "Сообщение" })
    .getByRole("button", { name: "Проверить", exact: true })
    .click();
  await expect(center.locator("article")).toHaveCount(2);
  fixture.replyNext("inbox.operation", { status: "accepted" });
  await center
    .locator("article")
    .filter({ hasText: "Ответ агенту" })
    .getByRole("button", { name: "Проверить", exact: true })
    .click();
  await expect(center.locator("article")).toHaveCount(1);
  fixture.replyNext("automations.receipt", { status: "applied" });
  await center
    .locator("article")
    .filter({ hasText: "Расписание" })
    .getByRole("button", { name: "Проверить", exact: true })
    .click();
  await expect(page.locator("#phone-notice")).toContainText("Выполнено");
  expect(
    fixture.calls.filter((call) => call.method === "automations.receipt").at(-1)
      ?.params,
  ).toEqual({ operationId: "job-op", profileId: "research" });
  expect(
    fixture.calls.filter((call) =>
      ["agent", "inbox.answer", "jobs.run"].includes(call.method),
    ),
  ).toHaveLength(0);
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
  await expect(
    page.getByRole("heading", { name: "Проверьте задачу", exact: true }),
  ).toBeFocused();
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
  await expect(
    page.getByRole("heading", { name: "Запуск задачи", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Продолжить с результатом", exact: true })
    .click();
  await expect(page.getByLabel("Сообщение Hermes")).toHaveValue(
    /Результат предыдущего запуска:/,
  );
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

test("a repeated-hour one-shot accepts an explicit UTC offset in the phone form", async ({
  page,
}) => {
  const { calls, replyNext } = await server(page);
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await page.getByRole("button", { name: "＋ Задача", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Разовая задача");
  await page.getByLabel("Инструкция и выбранный контекст").fill("Собери отчёт");
  await page.locator("#schedule-kind").selectOption("once");
  await page.locator('[name="date"]').fill("2027-10-31");
  await page.locator('[name="time"]').fill("02:30");
  const check = page.getByRole("button", { name: "Проверить расписание" });
  replyNext("automations.preview", { error: "ambiguous_local_time" });
  await check.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Этот час повторяется при переводе часов",
  );
  const offset = page.getByLabel("Сдвиг UTC для повторяющегося часа");
  await offset.fill("+01:00");
  replyNext("automations.preview", {
    preview: {
      reviewHash: "a".repeat(64),
      timezone: "Europe/Berlin",
      nextRuns: ["2027-10-31T02:30:00+01:00"],
    },
  });
  await check.click();
  await expect(page.locator("#schedule-preview")).toContainText(
    "2027-10-31 02:30:00+01:00",
  );
  await page.getByRole("button", { name: "Подтвердить и сохранить" }).click();
  expect(
    calls.find((call) => call.method === "automations.create")?.params.fields.schedule,
  ).toBe("2027-10-31T02:30:00+01:00");
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

test("a recovered approval names the previous decision while the new choice remains unsent", async ({
  page,
}) => {
  const fixture = workspaceFixture();
  const sent: any[] = [];
  const checked: string[] = [];
  fixture.replacePending([
    {
      id: "approval",
      sessionKey: "hermes:main:a",
      sessionTitle: "Проверка",
      agentName: "Hermes",
      kind: "permission",
      question: "Разрешить тестовую команду?",
      allowedDecisions: ["allow-once", "deny"],
      expiresAtMs: null,
      createdAtMs: Date.now(),
    },
  ]);
  await page.routeWebSocket("ws://127.0.0.1:47801/**", (socket) =>
    fixture.attach({
      send: (text) => socket.send(text),
      close: (options) => socket.close(options),
      onMessage: (handle) =>
        socket.onMessage((raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.method === "inbox.answer") {
            sent.push(frame.params);
            return;
          }
          if (frame.method === "inbox.operation") {
            checked.push(frame.params.operationId);
            fixture.replyNext("inbox.operation", { status: "accepted" });
          }
          handle(raw);
        }),
    }),
  );
  await page.clock.install();
  await connect(page);
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await page.locator("#inbox-list button").click();
  await page
    .getByRole("button", { name: "Разрешить один раз", exact: true })
    .click();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  await page.clock.fastForward(71000);
  await page
    .getByRole("button", { name: "Изменить / Назад", exact: true })
    .click();
  await page.getByRole("button", { name: "Запретить", exact: true }).click();
  await expect(page.locator("#phone-content")).toContainText(
    "Выбранный сейчас ответ ещё не отправлен",
  );
  fixture.resolveExternal();
  await page
    .getByRole("button", { name: "Проверить отправку", exact: true })
    .click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Принят предыдущий ответ",
  );
  expect(sent.map((frame) => frame.answer)).toEqual([
    { decision: "allow-once" },
  ]);
  expect(checked).toEqual([sent[0].operationId]);
});

test("new attachments survive a previous receipt and changed payload requires a new operation", async ({
  page,
}) => {
  const fixture = workspaceFixture();
  let dropBeforeAdmission = false;
  const sends: any[] = [];
  await page.routeWebSocket("ws://127.0.0.1:47801/**", (socket) =>
    fixture.attach({
      send: (text) => socket.send(text),
      close: (options) => socket.close(options),
      onMessage: (handle) =>
        socket.onMessage((raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.method === "agent") {
            sends.push(frame.params);
            if (dropBeforeAdmission) {
              dropBeforeAdmission = false;
              void socket.close({ code: 1012, reason: "Before admission" });
              return;
            }
          }
          handle(raw);
        }),
    }),
  );
  await connect(page);
  await page.getByRole("button", { name: /Первый чат/ }).click();
  const composer = page.getByLabel("Сообщение Hermes");
  const send = page
    .locator("#compose-chat")
    .getByRole("button", { name: "Отправить", exact: true });
  const pick = (name: string) =>
    page.locator("#files").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(name),
    });
  const remove = (name: string) =>
    page.getByRole("button", { name: `${name} ×`, exact: true }).click();
  const check = page.getByRole("button", {
    name: "Проверить отправку",
    exact: true,
  });
  const reconnected = () =>
    expect(page.locator("#phone-status")).toContainText("● Hermes", {
      timeout: 10000,
    });

  await composer.fill("Черновик");
  await pick("original.txt");
  fixture.dropNextReply("agent");
  await send.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Соединение потеряно",
  );
  await reconnected();
  await remove("original.txt");
  await pick("replacement.txt");
  await check.click();
  await expect(
    page.getByRole("button", { name: "replacement.txt ×", exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("Черновик");

  dropBeforeAdmission = true;
  await send.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Соединение потеряно",
  );
  await reconnected();
  await remove("replacement.txt");
  await pick("new.txt");
  await check.click();
  await send.click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Восстановите исходный текст",
  );
  expect(sends).toHaveLength(2);
  await page
    .getByRole("button", { name: "Отменить старую отправку", exact: true })
    .click();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(composer).toHaveValue("Черновик");
  await send.click();
  await expect.poll(() => sends.length).toBe(3);
  expect(sends[1].idempotencyKey).not.toBe(sends[2].idempotencyKey);
});

test("revocation cancels a captured schedule confirmation without retargeting the job", async ({
  page,
}) => {
  const fixture = await server(page);
  const job = {
    id: "shared-id",
    name: "Исходная задача",
    state: "scheduled",
    schedule: "0 9 * * *",
  };
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  fixture.replyNext("jobs.list", { jobs: [job] });
  await page.locator("#job-profile").selectOption("research");
  await page.getByRole("heading", { name: job.name, exact: true }).waitFor();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  fixture.update({ authorizedNamespaces: ["main"], pending: [] });
  await expect(page.locator("#job-profile")).toHaveCount(0);
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Профиль задачи изменился",
  );
  expect(
    fixture.calls.filter((frame) => frame.method === "jobs.pause"),
  ).toHaveLength(0);
});

test("periodic refresh preserves the search and live prefix, terminal events clear the stream", async ({
  page,
}) => {
  const fixture = await server(page);
  await page.clock.install();
  await connect(page);
  const search = page.getByLabel("Поиск чатов");
  await page.getByRole("button", { name: /Первый чат/ }).waitFor();
  await search.fill("Незавершённый поиск");
  const reads = fixture.calls.filter(
    (frame) => frame.method === "sessions.list",
  ).length;
  await page.clock.fastForward(16000);
  await expect
    .poll(
      () =>
        fixture.calls.filter((frame) => frame.method === "sessions.list")
          .length,
    )
    .toBeGreaterThan(reads);
  await expect(search).toHaveValue("Незавершённый поиск");
  await page.getByRole("button", { name: /Первый чат/ }).click();
  const run = { sessionKey: "hermes:main:a", runId: "prefix-run" };
  fixture.emit("streaming", { ...run, seq: 1, text: "Отчёт" });
  await expect(page.locator(".streaming")).toContainText("Отчёт");
  const subscriptions = fixture.calls.filter(
    (frame) => frame.method === "chat.subscribe",
  ).length;
  await page.clock.fastForward(16000);
  await expect
    .poll(
      () =>
        fixture.calls.filter((frame) => frame.method === "chat.subscribe")
          .length,
    )
    .toBeGreaterThan(subscriptions);
  await expect(page.locator(".streaming")).toContainText("Отчёт");
  fixture.emit("activity", { ...run, phase: "error" });
  await expect(page.locator(".streaming")).toHaveCount(0);
});

test("G2 paginates cron conversation by cursor and clears a revoked full-text screen", async ({
  page,
}) => {
  const fixture = await server(page);
  const key = "hermes:research:x:cron:qa";
  fixture.replaceCompleted([
    {
      id: "qa-result",
      sessionKey: key,
      sessionTitle: "Cron QA",
      agentName: "Hermes",
      summary: "Результат",
      read: false,
      createdAtMs: Date.now(),
    },
  ]);
  await page.goto("/?preview=1&hud=1");
  await page.locator("#connect [name=url]").fill("ws://127.0.0.1:47801/");
  await page.locator("#connect [name=token]").fill("key");
  await page.locator("#connect button").click();
  await expect(page.locator("#connection")).toHaveText("VPS подключён");
  await page.getByRole("button", { name: "Готово · 1", exact: true }).click();
  await page.getByRole("button", { name: /Cron QA/ }).click();
  fixture.replyNext("chat.history", {
    messages: [{ id: 11, role: "assistant", content: "Новая запись" }],
    hasMore: true,
    nextBeforeId: 11,
  });
  await page
    .getByRole("button", { name: "Открыть сессию", exact: true })
    .click();
  fixture.replyNext("chat.history", {
    messages: [
      { id: 10, role: "assistant", content: "Закрытая запись Research" },
    ],
    hasMore: false,
    nextBeforeId: 10,
  });
  await page
    .getByRole("button", { name: "Загрузить предыдущие", exact: true })
    .click();
  await page.getByRole("button", { name: /Закрытая запись Research/ }).click();
  await expect(page.locator("#body")).toContainText("Закрытая запись Research");
  fixture.update({
    authorizedNamespaces: ["main"],
    pending: [],
    completed: [],
  });
  await expect(page.locator("#body")).not.toContainText(
    "Закрытая запись Research",
  );
  await expect(page.locator("#title")).toHaveText("OcuClaw");
});

test("the phone keeps its older-results cursor across live snapshots", async ({
  page,
}) => {
  const fixture = await server(page);
  const item = (id: string, age: number) => ({
    id,
    sessionKey: "hermes:main:a",
    sessionTitle: id,
    agentName: "Hermes",
    summary: id,
    read: true,
    createdAtMs: Date.now() - age,
  });
  const first = item("Первая страница", 1000),
    second = item("Вторая страница", 2000),
    third = item("Третья страница", 3000);
  const cursor = ({ id, createdAtMs }: Completion) => ({ id, createdAtMs });
  fixture.replaceCompleted([first]);
  await connect(page);
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await page
    .getByRole("button", { name: "Результаты · 0", exact: true })
    .click();
  const older = page.getByRole("button", {
    name: "Предыдущие результаты",
    exact: true,
  });
  fixture.update({ completedNextBefore: cursor(first) });
  fixture.replyNext("inbox.completed", {
    items: [second],
    nextBefore: cursor(second),
  });
  await older.click();
  await expect(
    page.getByRole("heading", { name: second.id, exact: true }),
  ).toBeVisible();
  fixture.update({ completedNextBefore: cursor(first) });
  fixture.replyNext("inbox.completed", { items: [third], nextBefore: null });
  await older.click();
  await expect(
    page.getByRole("heading", { name: third.id, exact: true }),
  ).toBeVisible();
  expect(
    fixture.calls
      .filter((frame) => frame.method === "inbox.completed")
      .map((frame) => frame.params.before),
  ).toEqual([cursor(first), cursor(second)]);
});

test("the phone refreshes an open execution history and displays persisted registration errors", async ({
  page,
}) => {
  const fixture = workspaceFixture();
  const job = {
    id: "job",
    name: "Задача с ошибкой регистрации",
    registration: "failed",
    state: "scheduled",
    schedule: "0 9 * * *",
  };
  let status = "running";
  await page.routeWebSocket("ws://127.0.0.1:47801/**", (socket) =>
    fixture.attach({
      send: (text) => socket.send(text),
      close: (options) => socket.close(options),
      onMessage: (handle) =>
        socket.onMessage((raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.method === "jobs.list")
            fixture.replyNext(frame.method, { jobs: [job] });
          if (frame.method === "jobs.history")
            fixture.replyNext(frame.method, {
              history: [{ id: "run", jobId: job.id, status }],
            });
          handle(raw);
        }),
    }),
  );
  await page.clock.install();
  await connect(page);
  await page.getByRole("button", { name: "Расписание", exact: true }).click();
  await expect(page.locator("#job-list")).toContainText("Ошибка регистрации");
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(page.locator("#execution-list")).toContainText("Работает");
  status = "completed";
  await page.clock.fastForward(16000);
  await expect(page.locator("#execution-list")).toContainText("Готово");
  expect(
    fixture.calls.filter((frame) => frame.method === "jobs.history"),
  ).toHaveLength(2);
});

test("a pasted token is stripped from the saved address and a refused key deletion is visible", async ({
  page,
}) => {
  await server(page);
  await page.route("**/src/main.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      import { Glasses } from "/src/glasses.ts";
      import { Relay } from "/src/transport.ts";
      import { InboxModel } from "/src/model.ts";
      import { mountHud } from "/src/hud.ts";
      import { PhoneApp } from "/src/phone.ts";
      const root = document.querySelector("#app"), relay = new Relay(), inbox = new InboxModel();
      const glasses = new Glasses(async () => ({
        createStartUpPageContainer: async () => 1,
        onEvenHubEvent: () => () => {},
        getLocalStorage: async () => "",
        setLocalStorage: async () => false
      }));
      const hudRoot = document.createElement("section"), phone = document.createElement("section");
      hudRoot.hidden = true;
      root.append(phone, hudRoot);
      const hud = mountHud(relay, glasses, inbox, hudRoot);
      new PhoneApp(phone, relay, glasses, inbox, hud, hudRoot);
    `,
    }),
  );
  await page.goto("/");
  const settings = page.getByRole("button", { name: "Настройки", exact: true });
  await settings.click();
  await page
    .locator("#phone-url")
    .fill("ws://127.0.0.1:47801/?token=fixture-secret");
  await page.locator("#phone-token").fill("key");
  await page.locator("#phone-connect button").click();
  await expect(page.locator("#phone-status")).toContainText("● Hermes");
  expect(
    await page.evaluate(() => localStorage.getItem("ocuclaw.server")),
  ).toBe("ws://127.0.0.1:47801/");
  await settings.click();
  await page
    .getByRole("button", {
      name: "Забыть сохранённое подключение",
      exact: true,
    })
    .click();
  await expect(page.locator("#phone-notice")).toContainText(
    "Even Hub не удалил сохранённое подключение",
  );
});

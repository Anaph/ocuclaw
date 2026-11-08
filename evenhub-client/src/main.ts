import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/cyrillic-400.css";
import "./style.css";
import {
  InboxModel,
  canSend,
  sessionStatus,
  type Question,
  type Completion,
  type Session,
  type Answer,
  type Snapshot,
} from "./model";
import { Relay } from "./transport";
import { ReceiptStore, endpointScope, randomId, isSnapshot } from "./protocol";
import { Glasses, wavBase64 } from "./glasses";
type Screen =
  | "home"
  | "pending"
  | "completed"
  | "sessions"
  | "question"
  | "result"
  | "chat"
  | "menu"
  | "confirm"
  | "compose"
  | "read"
  | "record";
interface Action {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}
interface View {
  title: string;
  body?: string;
  actions: Action[];
}
const relay = new Relay(),
  glasses = new Glasses(),
  model = new InboxModel();
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<main><header><span class="brand">OCUCLAW</span><span id="connection">Нет связи</span></header><details open id="setup"><summary>Подключение к вашему VPS</summary><form id="connect"><label>Адрес сервера<input name="url" type="url" placeholder="wss://your-host.ts.net/" required></label><label>Ключ подключения<input name="token" type="password" autocomplete="off" required></label><label>Провайдер распознавания<input name="provider" placeholder="Автоматически из доступных"></label><button>Подключить</button></form><p>Ключ используется только в этой вкладке. Tailscale должен быть подключён на телефоне.</p></details><p id="notice" role="status"></p><section class="workspace"><div class="preview"><canvas id="display" width="576" height="288" aria-label="Экран очков"></canvas><nav id="controls"><button data-input="up">↑</button><button data-input="select">Выбрать</button><button data-input="down">↓</button><button data-input="back">Назад</button><button data-input="menu">Действия</button></nav></div><section><h1 id="title"></h1><p id="body"></p><div id="actions"></div><form id="text-form" hidden><label>Текст<input id="text" maxlength="16000" autocomplete="off"></label><button>Продолжить</button></form></section></section><footer>Свайп — перемещение · нажатие — выбор · двойное — назад</footer></main>`;
let screen: Screen = "home",
  selected = 0,
  sessions: Session[] = [],
  questionId = "",
  completionId = "",
  chatKey = "",
  chatTitle = "",
  messages: any[] = [],
  total = 0;
let confirmAction: (() => Promise<void>) | null = null,
  confirmText = "",
  confirmReturn: Screen = "question";
type Target =
  | { kind: "question"; id: string; key: string }
  | { kind: "message"; key: string }
  | { kind: "rename"; key: string }
  | { kind: "search" };
let target: Target | null = null,
  draft = "",
  readText = "",
  readPage = 0,
  readReturn: Screen = "question",
  notice = "",
  busy = false,
  available = false;
let current: View = { title: "OcuClaw", actions: [] },
  notification: Question | Completion | null = null,
  notificationTimer: ReturnType<typeof setTimeout> | null = null,
  sawSnapshot = false;
let nextCompleted: { id: string; createdAtMs: number } | null = null,
  loadedOlder = false;
const notificationQueue: (Question | Completion)[] = [],
  positions = new Map<string, string>(),
  stopping = new Set<string>();
let choices = new Set<number>();
let connectionGeneration = 0,
  connectionScope = "",
  sessionSearch = "";
let receipts: ReceiptStore | null = null;
function uiKey() {
  return `ocuclaw.ui:${encodeURIComponent(connectionScope)}`;
}
function resetConnection(scope: string) {
  connectionGeneration++;
  connectionScope = scope;
  notice = "";
  model.reset();
  sessions = [];
  messages = [];
  total = 0;
  chatKey = "";
  chatTitle = "";
  questionId = "";
  completionId = "";
  confirmAction = null;
  confirmText = "";
  target = null;
  draft = "";
  textField.value = "";
  readText = "";
  readPage = 0;
  clearNotification();
  notificationQueue.length = 0;
  positions.clear();
  stopping.clear();
  choices.clear();
  screen = "home";
  selected = 0;
  sawSnapshot = false;
  loadedOlder = false;
  nextCompleted = null;
  available = false;
  sessionSearch = "";
  receipts = new ReceiptStore(sessionStorage, scope);
  // A receipt from the old unscoped format cannot be safely assigned to a server.
  sessionStorage.removeItem("ocuclaw.pendingOperation");
  try {
    const saved = JSON.parse(localStorage.getItem(uiKey()) || "null");
    if (
      saved &&
      ["home", "pending", "completed", "sessions"].includes(saved.screen)
    ) {
      screen = saved.screen;
      for (const [key, id] of saved.positions || [])
        if (typeof key === "string" && typeof id === "string")
          positions.set(key, id);
    }
  } catch {}
}
const textField = document.querySelector<HTMLInputElement>("#text")!,
  providerField = document.querySelector<HTMLInputElement>("[name=provider]")!;
const q = () => model.snapshot.pending.find((x) => x.id === questionId),
  result = () => model.snapshot.completed.find((x) => x.id === completionId);
const titleOf = (s: Session) => s.label || s.displayName || s.title || s.key;
function message(text: string) {
  notice = text;
  render();
}
function run(action: () => void | Promise<void>) {
  if (busy) return;
  try {
    const p = action();
    if (p instanceof Promise) {
      busy = true;
      render();
      void p
        .catch((e) => message(String(e.message)))
        .finally(() => {
          busy = false;
          render();
          showNotification();
        });
    }
  } catch (e) {
    message(String((e as Error).message));
  }
}
function go(next: Screen) {
  notice = "";
  positions.set(screen, current.actions[selected]?.id || "");
  screen = next;
  selected = 0;
  if (next === "pending") model.enter();
  render();
}
function confirm(
  text: string,
  action: () => Promise<void>,
  back: Screen = screen,
) {
  confirmText = text;
  confirmAction = action;
  confirmReturn = back;
  go("confirm");
}
function full(text: string) {
  readText = text;
  readPage = 0;
  readReturn = screen;
  go("read");
}
function compose(next: Target) {
  target = next;
  draft = "";
  textField.value = "";
  go("compose");
}
async function refreshSessions(search = sessionSearch) {
  const generation = connectionGeneration;
  sessionSearch = search;
  const data = await relay.request("sessions.list", { search });
  if (generation !== connectionGeneration || search !== sessionSearch) return;
  sessions = data.sessions || [];
  for (const s of sessions)
    if (
      s.agentStatus?.working === false &&
      !s.agentStatus.unknown &&
      !s.agentStatus.needsYou
    )
      stopping.delete(s.key);
}
async function openChat(key: string, title = key) {
  const generation = connectionGeneration;
  const data = await relay.request("chat.history", {
    sessionKey: key,
    limit: 20,
  });
  if (generation !== connectionGeneration) return;
  chatKey = key;
  chatTitle = title;
  messages = data.messages || [];
  total = data.total ?? messages.length;
  go("chat");
}
function questionAnswer(answer: Answer) {
  const item = q();
  if (!item || !canSend(item)) return message("Вопрос уже не актуален");
  const bound = {
    id: item.id,
    sessionKey: item.sessionKey,
    operationId: randomId(),
    answer,
  };
  const shown =
    "text" in answer
      ? answer.text
      : "decision" in answer
        ? decisionLabel(answer.decision)
        : answer.indices.map((i) => item.choices![i]).join(", ");
  confirm(
    `${item.agentName} / ${item.sessionTitle}\n\nОтправить: «${shown}»?`,
    async () => {
      const fresh = await relay.request("inbox.get", {
        id: bound.id,
        sessionKey: bound.sessionKey,
      });
      if (fresh.status !== "pending") {
        go("pending");
        return message(statusLabel(fresh.status));
      }
      receipts!.save({
        operationId: bound.operationId,
        id: bound.id,
        sessionKey: bound.sessionKey,
      });
      const reply = await relay.request("inbox.answer", bound);
      if (reply.status !== "uncertain") receipts?.clear();
      if (reply.status === "accepted") {
        go("pending");
        message("Ответ принят");
        await refreshInbox();
      } else message(statusLabel(reply.status));
    },
    "question",
  );
}
function statusLabel(status: string) {
  return (
    (
      {
        accepted: "Ответ принят",
        expired: "Время ответа истекло",
        already_answered: "Вопрос уже закрыт",
        source_unavailable: "Hermes недоступен",
        not_found: "Запрос не найден",
        uncertain:
          "Отправка не подтверждена. Проверьте состояние после подключения.",
      } as Record<string, string>
    )[status] || status
  );
}
function decisionLabel(d: string) {
  return (
    (
      {
        "allow-once": "Разрешить один раз",
        "allow-session": "Разрешить для сессии",
        deny: "Отклонить",
        once: "Разрешить один раз",
        session: "Разрешить для сессии",
      } as Record<string, string>
    )[d] || d
  );
}
function content(value: any): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((x) => x.text || "").join("\n")
      : "";
}
function remaining(item: Question) {
  if (item.expiresAtMs === null) return "Без таймера";
  const seconds = Math.max(
    0,
    Math.ceil((item.expiresAtMs - Date.now()) / 1000),
  );
  return seconds
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : "Срок истёк";
}
function view(): View {
  const close: Action = { id: "back", label: "Назад", run: back };
  if (notification)
    return {
      title: `${"question" in notification ? "Новый вопрос" : "Готово"} · ${notification.agentName}`,
      body:
        "question" in notification
          ? notification.question
          : notification.summary,
      actions: [
        {
          id: "open",
          label: "Открыть",
          run: () => {
            const item = notification!;
            clearNotification();
            if ("question" in item) {
              questionId = item.id;
              choices.clear();
              go("question");
            } else {
              completionId = item.id;
              go("result");
            }
          },
        },
      ],
    };
  if (screen === "home")
    return {
      title: "OcuClaw",
      body: !available
        ? "Нет связи с источником вопросов"
        : !model.snapshot.capabilities.allGatewayQuestions
          ? "Только вопросы OcuClaw. Для Desktop нужен публичный источник Hermes."
          : "Все подключённые сессии Hermes",
      actions: [
        {
          id: "pending",
          label: `Нужен ответ · ${model.snapshot.pending.length}`,
          run: () => go("pending"),
        },
        {
          id: "completed",
          label: `Готово · ${model.snapshot.unreadCompleted ?? model.snapshot.completed.filter((x) => !x.read).length}`,
          run: () => go("completed"),
        },
        {
          id: "sessions",
          label: "Сессии",
          run: async () => {
            await refreshSessions();
            go("sessions");
          },
        },
      ],
    };
  if (screen === "pending")
    return {
      title: `Нужен ответ · ${model.order.length}`,
      actions: model.order
        .map((id) => model.snapshot.pending.find((x) => x.id === id)!)
        .filter(Boolean)
        .map((item) => ({
          id: item.id,
          label: `${item.agentName} / ${item.sessionTitle}\n${item.question}\n${item.kind === "permission" ? "Разрешение" : "Вопрос"} · ${remaining(item)}`,
          run: () => {
            questionId = item.id;
            choices.clear();
            go("question");
          },
        })),
    };
  if (screen === "completed")
    return {
      title: "Готово",
      actions: [
        ...model.snapshot.completed.map((item) => ({
          id: item.id,
          label: `${item.read ? "" : "● "}${item.agentName} / ${item.sessionTitle}\n${item.summary}\n${new Date(item.createdAtMs).toLocaleString("ru-RU")}`,
          run: () => {
            completionId = item.id;
            go("result");
          },
        })),
        ...(nextCompleted
          ? [
              {
                id: "more-results",
                label: "Загрузить предыдущие результаты",
                run: async () => {
                  const page = await relay.request("inbox.completed", {
                    before: nextCompleted,
                  });
                  model.update({ ...model.snapshot, completed: page.items });
                  nextCompleted = page.nextBefore;
                  loadedOlder = true;
                  render();
                },
              },
            ]
          : []),
      ],
    };
  if (screen === "sessions")
    return {
      title: "Сессии",
      actions: [
        ...(sessionSearch
          ? [
              {
                id: "clear-search",
                label: "Сбросить поиск",
                run: async () => {
                  await refreshSessions("");
                  render();
                },
              },
            ]
          : []),
        {
          id: "new",
          label: "+ Новая сессия",
          run: async () => {
            const created = await relay.request("sessions.create");
            chatKey = created.key;
            chatTitle = "Новая сессия";
            compose({ kind: "message", key: created.key });
          },
        },
        {
          id: "search",
          label: "Поиск",
          run: () => compose({ kind: "search" }),
        },
        ...sessions
          .slice()
          .sort(
            (a, b) =>
              Number(b.pinned) - Number(a.pinned) ||
              (b.updatedAt || 0) - (a.updatedAt || 0),
          )
          .map((s) => ({
            id: s.key,
            label: `${s.pinned ? "★ " : ""}${titleOf(s)}\n${stopping.has(s.key) ? "Остановка запрошена" : sessionStatus(s, relay.online)}`,
            run: () => openChat(s.key, titleOf(s)),
          })),
      ],
    };
  if (screen === "question") {
    const item = q();
    if (!item)
      return {
        title: "Вопрос закрыт",
        body: "Ответ уже получен или срок истёк.",
        actions: [close],
      };
    let actions: Action[] = [];
    if (item.kind === "permission")
      actions = (item.allowedDecisions || []).map((decision) => ({
        id: decision,
        label: decisionLabel(decision),
        run: () => questionAnswer({ decision }),
      }));
    else {
      actions = (item.choices || []).map((label, i) => ({
        id: `choice:${i}`,
        label: `${item.multiSelect ? (choices.has(i) ? "☑ " : "☐ ") : ""}${label}`,
        run: () => {
          if (item.multiSelect) {
            choices.has(i) ? choices.delete(i) : choices.add(i);
            render();
          } else questionAnswer({ indices: [i] });
        },
      }));
      if (item.multiSelect)
        actions.push({
          id: "choose",
          label: "Продолжить",
          run: () =>
            choices.size
              ? questionAnswer({ indices: [...choices] })
              : message("Выберите хотя бы один вариант"),
        });
      if (!item.choices?.length || item.allowOther)
        actions.push({
          id: "dictate",
          label: "Ответить голосом или текстом",
          run: () =>
            compose({ kind: "question", id: item.id, key: item.sessionKey }),
        });
    }
    actions.push(
      {
        id: "read",
        label: "Полный текст вопроса",
        run: () => full(item.question),
      },
      {
        id: "chat",
        label: "Открыть сессию",
        run: () => openChat(item.sessionKey, item.sessionTitle),
      },
    );
    return {
      title: `${item.agentName} / ${item.sessionTitle}`,
      body: `${item.question}\n${remaining(item)}`,
      actions,
    };
  }
  if (screen === "result") {
    const item = result();
    if (!item) return { title: "Результат недоступен", actions: [close] };
    return {
      title: item.sessionTitle,
      body: item.summary,
      actions: [
        {
          id: "read",
          label: "Прочитать результат",
          run: () => full(item.summary),
        },
        {
          id: "chat",
          label: "Открыть сессию",
          run: () => openChat(item.sessionKey, item.sessionTitle),
        },
        {
          id: "continue",
          label: "Продолжить голосом",
          run: () => compose({ kind: "message", key: item.sessionKey }),
        },
        {
          id: "seen",
          label: "Отметить прочитанным",
          run: async () => {
            await relay.request("inbox.read", { id: item.id });
            item.read = true;
            await refreshInbox();
            go("completed");
          },
        },
      ],
    };
  }
  if (screen === "chat")
    return {
      title: chatTitle,
      body: `Загружено ${messages.length} из ${total}`,
      actions: [
        {
          id: "send",
          label: "Написать / надиктовать",
          run: () => compose({ kind: "message", key: chatKey }),
        },
        { id: "menu", label: "Действия с сессией", run: () => go("menu") },
        ...messages.map((m, i) => ({
          id: String(m.id ?? i),
          label: `${m.role === "user" ? "Вы" : "Агент"}: ${content(m.content)}`,
          run: () => full(content(m.content)),
        })),
        ...(messages.length < total && messages[0]?.id
          ? [
              {
                id: "earlier",
                label: "Загрузить предыдущие",
                run: async () => {
                  const page = await relay.request("chat.history", {
                    sessionKey: chatKey,
                    beforeId: messages[0].id,
                    limit: 20,
                  });
                  if (page.rowIdsUnavailable)
                    throw Error("Hermes не предоставляет курсоры истории");
                  const seen = new Set(messages.map((x) => x.id));
                  messages = [
                    ...page.messages.filter((m: any) => !seen.has(m.id)),
                    ...messages,
                  ];
                  render();
                },
              },
            ]
          : []),
      ],
    };
  if (screen === "menu") {
    const s = sessions.find((x) => x.key === chatKey);
    const acts: Action[] = [];
    if (s?.actions?.pin)
      acts.push({
        id: "pin",
        label: s.pinned ? "Открепить" : "Закрепить",
        run: async () => {
          const reply = await relay.request("sessions.pin", {
            key: chatKey,
            pinned: !s.pinned,
          });
          if (reply.ok === false)
            throw Error(reply.reason || "Не удалось закрепить");
          await refreshSessions();
          back();
        },
      });
    if (s?.actions?.rename)
      acts.push({
        id: "rename",
        label: "Переименовать",
        run: () => compose({ kind: "rename", key: chatKey }),
      });
    if (s?.actions?.hide)
      acts.push({
        id: "hide",
        label: "Скрыть из списка",
        run: () =>
          confirm("Скрыть сессию? Вопросы останутся во Входящих.", async () => {
            await relay.request("sessions.patch", {
              key: chatKey,
              hidden: true,
            });
            await refreshSessions();
            go("sessions");
          }),
      });
    if (s?.actions?.stop)
      acts.push({
        id: "stop",
        label: "Остановить задачу",
        run: () =>
          confirm("Запросить остановку задачи?", async () => {
            await relay.request("sessions.abort", { key: chatKey });
            stopping.add(chatKey);
            go("sessions");
          }),
      });
    return {
      title: "Действия с сессией",
      body: acts.length
        ? chatTitle
        : "Сессией управляет Desktop. Ответьте на её вопрос во Входящих.",
      actions: [...acts, close],
    };
  }
  if (screen === "confirm")
    return {
      title: "Подтверждение",
      body: confirmText,
      actions: [
        {
          id: "send",
          label: "Отправить",
          run: async () => {
            await confirmAction?.();
          },
        },
        {
          id: "full",
          label: "Прочитать ответ полностью",
          run: () => full(confirmText),
        },
        {
          id: "edit",
          label: "Изменить / перезаписать",
          run: () => go(confirmReturn),
        },
        { id: "cancel", label: "Отмена", run: () => go(confirmReturn) },
      ],
    };
  if (screen === "compose")
    return {
      title:
        target?.kind === "search"
          ? "Поиск сессий"
          : target?.kind === "rename"
            ? "Название сессии"
            : "Ответ агенту",
      body: draft || "Введите текст на телефоне или включите микрофон.",
      actions: [
        {
          id: "voice",
          label: "Надиктовать · до 17 секунд",
          run: startRecording,
        },
        { id: "use", label: "Продолжить с текстом", run: useDraft },
        close,
      ],
    };
  if (screen === "record")
    return {
      title: "Слушаю…",
      body: "Нажмите для окончания записи. Ответ ещё не отправлен.",
      actions: [
        { id: "stop", label: "Завершить запись", run: finishRecording },
        {
          id: "cancel",
          label: "Отменить запись",
          run: async () => {
            clearTimeout(recordTimer);
            await glasses.stop();
            go("compose");
          },
        },
      ],
    };
  const chunks = readChunks(readText);
  return {
    title: `Текст · ${readPage + 1}/${chunks.length}`,
    body: chunks[readPage] || "",
    actions: [
      {
        id: "next",
        label: "Следующая страница",
        run: () => {
          readPage = (readPage + 1) % chunks.length;
          render();
        },
      },
      {
        id: "prev",
        label: "Предыдущая страница",
        run: () => {
          readPage = (readPage + chunks.length - 1) % chunks.length;
          render();
        },
      },
      close,
    ],
  };
}
function useDraft() {
  draft = textField.value.trim() || draft;
  if (!draft) return message("Введите или надиктуйте текст");
  if (!target) return;
  const boundTarget = target,
    boundDraft = draft,
    sendId = randomId();
  if (boundTarget.kind === "question") {
    questionId = boundTarget.id;
    const item = q();
    if (!item || item.sessionKey !== boundTarget.key)
      return message("Вопрос закрыт");
    questionAnswer({ text: boundDraft });
    confirmReturn = "compose";
  } else if (boundTarget.kind === "search")
    return refreshSessions(boundDraft).then(() => go("sessions"));
  else
    confirm(
      `Отправить: «${boundDraft}»?`,
      async () => {
        if (boundTarget.kind === "rename")
          await relay.request("sessions.patch", {
            key: boundTarget.key,
            label: boundDraft,
          });
        else
          await relay.request("agent", {
            sessionKey: boundTarget.key,
            message: boundDraft,
            idempotencyKey: sendId,
          });
        await refreshSessions();
        await openChat(boundTarget.key);
      },
      "compose",
    );
}
let recordTimer: ReturnType<typeof setTimeout> | undefined,
  transcribing = false;
async function startRecording() {
  await glasses.start();
  go("record");
  recordTimer = setTimeout(() => run(finishRecording), 17000);
}
async function finishRecording() {
  if (transcribing || screen !== "record") return;
  transcribing = true;
  clearTimeout(recordTimer);
  try {
    const pcm = await glasses.stop();
    go("compose");
    if (!pcm.length) throw Error("Запись пуста");
    let provider = providerField.value.trim();
    if (!provider) {
      const listing = await relay.request("workspace.stt.providers");
      provider = listing.providers?.find((x: any) => x.available)?.id;
    }
    if (!provider) throw Error("На VPS не настроено распознавание речи");
    const reply = await relay.request("workspace.stt.transcribe", {
      wav: wavBase64(pcm),
      provider,
      language: "ru",
    });
    if (!reply.success)
      throw Error(reply.error || "Не удалось распознать речь");
    draft = reply.transcript;
    textField.value = draft;
    message("Проверьте текст перед отправкой");
  } finally {
    transcribing = false;
  }
}
function back() {
  if (notification) {
    clearNotification();
    render();
    return;
  }
  if (screen === "record") {
    clearTimeout(recordTimer);
    run(async () => {
      await glasses.stop();
      go("compose");
    });
    return;
  }
  if (screen === "read") {
    go(readReturn);
    return;
  }
  if (screen === "confirm") {
    go(confirmReturn);
    return;
  }
  if (screen === "compose") {
    go(target?.kind === "question" ? "question" : "sessions");
    return;
  }
  if (screen === "question") {
    go("pending");
    return;
  }
  if (screen === "result") {
    go("completed");
    return;
  }
  if (screen === "menu") {
    go("chat");
    return;
  }
  if (screen === "chat") {
    go("sessions");
    return;
  }
  go("home");
}
function clearNotification() {
  notification = null;
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = null;
}
function showNotification() {
  if (
    notification ||
    ["record", "confirm", "compose"].includes(screen) ||
    (screen === "read" && ["confirm", "compose"].includes(readReturn)) ||
    busy
  )
    return;
  notification = null;
  while (notificationQueue.length && !notification) {
    const item = notificationQueue.shift()!;
    if (
      "question" in item
        ? model.snapshot.pending.some((x) => x.id === item.id) && canSend(item)
        : model.snapshot.completed.some((x) => x.id === item.id)
    )
      notification = item;
  }
  if (notification) {
    notificationTimer = setTimeout(() => {
      clearNotification();
      render();
      showNotification();
    }, 3000);
    render();
  }
}
async function refreshInbox() {
  const generation = connectionGeneration;
  const snapshot = await relay.request("inbox.snapshot");
  if (generation !== connectionGeneration) return;
  applySnapshot(snapshot);
}
async function reconcileOperation() {
  const generation = connectionGeneration,
    store = receipts;
  const pending = store?.load();
  if (!pending) return;
  const receipt = await relay.request("inbox.operation", {
    operationId: pending.operationId,
  });
  if (generation !== connectionGeneration) return;
  if (receipt.status === "accepted") {
    receipts?.clear();
    message("Предыдущий ответ принят Hermes");
  } else {
    const current = await relay.request("inbox.get", pending);
    if (generation !== connectionGeneration) return;
    if (current.status === "source_unavailable") {
      message(
        "Источник вопросов недоступен. Предыдущая отправка ещё не подтверждена.",
      );
      return;
    }
    message(
      current.status === "pending"
        ? "Предыдущая отправка не подтверждена. Вопрос ещё ожидает ответа."
        : "Предыдущий запрос больше не активен. Повторной отправки не было.",
    );
    if (current.status !== "pending") store?.clear();
  }
}
function applySnapshot(snapshot: Snapshot) {
  if (!isSnapshot(snapshot)) throw Error("Некорректный снимок Входящих");
  const before = new Set(model.snapshot.pending.map((x) => x.id));
  const beforeCompleted = new Set(model.snapshot.completed.map((x) => x.id));
  if (!loadedOlder) nextCompleted = snapshot.completedNextBefore ?? null;
  model.update(snapshot);
  available = snapshot.available;
  if (sawSnapshot)
    for (const item of snapshot.pending)
      if (!before.has(item.id)) notificationQueue.push(item);
  if (sawSnapshot)
    for (const item of snapshot.completed)
      if (!beforeCompleted.has(item.id)) notificationQueue.push(item);
  sawSnapshot = true;
  render();
  showNotification();
}
relay.onSnapshot = applySnapshot;
relay.onError = message;
relay.onState = (online) => {
  document.querySelector("#connection")!.textContent = online
    ? "VPS подключён"
    : "Нет связи";
  if (online) void reconcileOperation().catch(() => {});
  else available = false;
  render();
};
glasses.onInput = (input) => {
  if (busy) return;
  if (input === "back") return back();
  if (input === "menu") {
    if (screen === "record") return;
    if (screen === "confirm") return;
    go(screen === "chat" ? "menu" : "home");
    return;
  }
  if (input === "select") {
    const action = current.actions[selected];
    if (action) run(action.run);
    return;
  }
  selected =
    (selected + (input === "up" ? -1 : 1) + current.actions.length) %
    Math.max(1, current.actions.length);
  positions.set(screen, current.actions[selected]?.id || "");
  render(false);
};
glasses.onMenu = (id) => {
  if (busy || ["record", "confirm"].includes(screen)) return;
  if (id === 102)
    run(async () => {
      await refreshSessions();
      go("sessions");
    });
  else if (id === 103 && screen === "chat") go("menu");
  else go("home");
};
glasses.onError = (text) => {
  document.querySelector("#notice")!.textContent = text;
};
glasses.onLimit = () => run(finishRecording);
function wrap(text: string, width: number, size: number) {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${size}px 'Noto Sans'`;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (
        ctx.measureText(line + (line ? " " : "") + word).width > width &&
        line
      ) {
        lines.push(line);
        line = "";
      }
      if (ctx.measureText(word).width > width) {
        for (const char of word) {
          if (ctx.measureText(line + char).width > width) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      } else line += (line ? " " : "") + word;
    }
    lines.push(line);
  }
  return lines;
}
function readChunks(text: string) {
  const lines = wrap(text, 550, 22),
    chunks: string[] = [];
  for (let i = 0; i < lines.length; i += 6)
    chunks.push(lines.slice(i, i + 6).join("\n"));
  return chunks.length ? chunks : [""];
}
function clip(text: string, width: number, size: number) {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${size}px 'Noto Sans'`;
  if (ctx.measureText(text).width <= width) return text;
  while (text && ctx.measureText(text + "…").width > width)
    text = text.slice(0, -1);
  return text + "…";
}
function draw(v: View) {
  const canvas = document.createElement("canvas");
  canvas.width = 576;
  canvas.height = 288;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#000";
  c.fillRect(0, 0, 576, 288);
  c.fillStyle = "#fff";
  c.font = "20px 'Noto Sans'";
  c.fillText(v.title.slice(0, 45), 12, 25);
  c.fillRect(12, 35, 552, 1);
  let y = 60;
  if (v.body) {
    c.font = "19px 'Noto Sans'";
    for (const line of wrap(v.body, 548, 19).slice(
      0,
      screen === "read" ? 6 : 2,
    )) {
      c.fillText(line, 12, y);
      y += 25;
    }
  }
  const rowHeight = ["pending", "completed"].includes(screen) ? 70 : 53;
  const count =
    screen === "read" ? 1 : Math.max(1, Math.floor((270 - y) / rowHeight));
  const first = Math.max(
    0,
    Math.min(selected - Math.floor(count / 2), v.actions.length - count),
  );
  for (let i = first; i < Math.min(v.actions.length, first + count); i++) {
    c.font = "20px 'Noto Sans'";
    if (i === selected) {
      c.strokeStyle = "#fff";
      c.strokeRect(4, y - 21, 568, rowHeight - 4);
    }
    const lines = v.actions[i].label.split("\n");
    c.fillText((i === selected ? "> " : "  ") + clip(lines[0], 510, 20), 12, y);
    if (lines[1]) {
      c.font = "16px 'Noto Sans'";
      c.fillText(clip(lines[1], 525, 16), 32, y + 21);
    }
    if (lines[2] && ["pending", "completed"].includes(screen)) {
      c.font = "13px 'Noto Sans'";
      c.fillText(clip(lines[2], 525, 13), 32, y + 38);
    }
    y += rowHeight;
  }
  c.font = "13px 'Noto Sans'";
  c.fillText(
    busy
      ? "Ожидаю подтверждение сервера…"
      : `${Math.min(selected + 1, v.actions.length)}/${v.actions.length} · двойное нажатие — назад`,
    12,
    282,
  );
  return canvas;
}
function render(restore = true) {
  current = view();
  if (restore) {
    const id = positions.get(screen),
      i = current.actions.findIndex((x) => x.id === id);
    if (i >= 0) selected = i;
  }
  selected = Math.min(
    Math.max(selected, 0),
    Math.max(0, current.actions.length - 1),
  );
  document.querySelector("#title")!.textContent = current.title;
  document.querySelector("#body")!.textContent = current.body || "";
  document.querySelector("#notice")!.textContent = notice;
  const actions = document.querySelector("#actions")!;
  actions.replaceChildren();
  current.actions.forEach((action, i) => {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.className = i === selected ? "selected" : "";
    button.disabled = busy;
    button.onclick = () => {
      selected = i;
      positions.set(screen, action.id);
      run(action.run);
    };
    actions.append(button);
  });
  document.querySelector<HTMLFormElement>("#text-form")!.hidden =
    screen !== "compose";
  textField.disabled = busy;
  const canvas = draw(current);
  document
    .querySelector<HTMLCanvasElement>("#display")!
    .getContext("2d")!
    .drawImage(canvas, 0, 0);
  glasses.paint(canvas);
  if (["home", "pending", "completed", "sessions"].includes(screen))
    localStorage.setItem(
      uiKey(),
      JSON.stringify({ screen, positions: [...positions] }),
    );
}
document.querySelector("#controls")!.addEventListener("click", (event) => {
  const input = (event.target as HTMLElement).dataset.input;
  if (input) glasses.onInput(input as any);
});
document.querySelector("#connect")!.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget as HTMLFormElement);
  try {
    if (busy || screen === "record")
      return message(
        "Завершите текущую отправку или запись перед сменой сервера",
      );
    const address = String(data.get("url")),
      token = String(data.get("token"));
    const scope = endpointScope(address);
    if (!token.trim()) throw Error("Введите ключ подключения");
    resetConnection(scope);
    relay.connect(address, token);
    render();
    (document.querySelector("#setup") as HTMLDetailsElement).open = false;
  } catch (e) {
    message((e as Error).message);
  }
});
textField.addEventListener("input", () => {
  draft = textField.value;
  render();
});
document.querySelector("#text-form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  draft = textField.value;
  run(useDraft);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && relay.online) {
    void refreshInbox().catch(() => {});
    if (screen === "sessions")
      void refreshSessions()
        .then(() => render())
        .catch(() => {});
  }
});
window.addEventListener("pagehide", () => {
  clearTimeout(recordTimer);
  void glasses.stop().catch((error) => glasses.onError(String(error.message)));
  if (screen === "record") screen = "compose";
});
void document.fonts.ready.then(() => render());
render();
void glasses
  .init()
  .then(() => render())
  .catch(() =>
    message(
      "Предпросмотр готов. Для микрофона и G2 откройте плагин в Even Hub.",
    ),
  );
setInterval(() => {
  if (relay.online && !busy && screen === "sessions")
    void refreshSessions()
      .then(() => render())
      .catch(() => {});
}, 5000);

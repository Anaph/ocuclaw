import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/cyrillic-400.css";
import "./style.css";
import {
  InboxModel,
  canSend,
  orderedQuestions,
  sessionStatus,
  type Question,
  type Completion,
  type Session,
  type Answer,
  type Snapshot,
} from "./model";
import { Relay } from "./transport";
import { ReceiptStore, endpointScope, isSnapshot } from "./protocol";
import {
  Workspace,
  ScheduleRejected,
  errorText,
  statusText,
  type Job,
  type ScheduleFields,
  type SendAttempt,
} from "./workspace";
import { Glasses, wavBase64 } from "./glasses";
import type { Input } from "./hud-input";
import { sendHandoff, type Handoff } from "./handoff";
type Screen =
  | "jobs"
  | "job"
  | "home"
  | "pending"
  | "answered"
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
  bodyLines?: string[];
  actions: Action[];
}
interface Confirmation {
  id: number;
  text: string;
  bodyLines?: string[];
  label: string;
  checkLabel?: string;
  retryLabel?: string;
  back: Screen;
  send: () => Promise<void>;
  check?: () => Promise<void>;
  phase: "review" | "check" | "retry";
}
export function mountHud(
  relay: Relay,
  glasses: Glasses,
  model: InboxModel,
  app: HTMLElement,
) {
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
  let confirmation: Confirmation | null = null;
  let confirmationId = 0,
    shownAction = "",
    lastTap = -Infinity;
  type Target =
    | { kind: "question"; id: string; key: string }
    | { kind: "message"; key: string; context?: string; attempt?: SendAttempt }
    | { kind: "rename"; key: string }
    | { kind: "search" }
    | { kind: "schedule"; recovery?: Confirmation };
  let target: Target | null = null,
    draft = "",
    voiceRetry: Uint8Array | null = null,
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
  const workspace = new Workspace(relay, model);
  let currentJob: Job | null = null;
  let connectionGeneration = 0,
    connectionScope = "",
    sessionSearch = "";
  let receipts: ReceiptStore | null = null;
  function uiKey() {
    return `ocuclaw.ui:${encodeURIComponent(connectionScope)}`;
  }
  function resetConnection(scope: string) {
    connectionGeneration++;
    workspace.reset(scope);
    currentJob = null;
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
    confirmation = null;
    shownAction = "";
    lastTap = -Infinity;
    target = null;
    draft = "";
    voiceRetry = null;
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
  const textField = app.querySelector<HTMLInputElement>("#text")!,
    providerField = app.querySelector<HTMLInputElement>("[name=provider]")!;
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
    if (notification) clearNotification();
    notice = "";
    screen = next;
    selected = 0;
    if (next === "pending") model.enter();
    render();
    showNotification();
  }
  function confirm(
    text: string,
    action: () => Promise<void>,
    back: Screen = screen,
    options: Partial<
      Pick<
        Confirmation,
        "label" | "phase" | "bodyLines" | "checkLabel" | "retryLabel"
      >
    > = {},
  ) {
    confirmation = {
      id: ++confirmationId,
      text,
      label: options.label ?? "Отправить",
      bodyLines: options.bodyLines,
      checkLabel: options.checkLabel,
      retryLabel: options.retryLabel,
      back,
      send: action,
      phase: options.phase ?? "review",
    };
    positions.delete("confirm");
    go("confirm");
    return confirmation;
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
    voiceRetry = null;
    textField.value = "";
    go("compose");
  }
  function openQuestion(item: Question) {
    questionId = item.id;
    choices.clear();
    go("question");
  }
  function handoff(kind: Handoff["kind"], item: Question | Completion) {
    if (!connectionScope) return message("Сначала подключитесь к Hermes");
    sendHandoff(connectionScope, {
      kind,
      id: item.id,
      sessionKey: item.sessionKey,
    });
    message("Готово к открытию на телефоне");
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
  function questionAnswer(answer: Answer, back: Screen = "question") {
    const item = q();
    if (!item || !canSend(item)) return message("Вопрос уже не актуален");
    const shown =
      "text" in answer
        ? answer.text
        : "decision" in answer
          ? decisionLabel(answer.decision)
          : answer.indices.map((i) => item.choices![i]).join(", ");
    const attempt = workspace.answerAttempt(item);
    const context = `${item.agentName} / ${item.sessionTitle}`;
    const action = "decision" in answer ? item.permissionCommand : null;
    const summary = [`«${shown}»`, action, context].filter(Boolean).join("\n");
    const submit = async () => {
      try {
        if (!attempt.operationId && !canSend(item))
          return showOutcome({ status: "expired" });
        showOutcome(await workspace.answer(item, answer, attempt));
      } catch (error) {
        flow.phase = "check";
        throw error;
      }
    };
    const flow = confirm(summary, submit, back, {
      phase: attempt.operationId ? "check" : "review",
    });
    function showOutcome(reply: { status: string; error?: string }) {
      if (
        ["accepted", "already_answered", "expired", "not_found"].includes(
          reply.status,
        )
      ) {
        if (reply.status === "accepted") {
          positions.delete("answered");
          go("answered");
        } else go("pending");
        void refreshInbox().catch(() => {});
      } else {
        flow.phase = reply.status === "rejected" ? "review" : "check";
        if (reply.status === "rejected") attempt.operationId = undefined;
      }
      message(reply.error || statusLabel(reply.status));
    }
    flow.check = async () => {
      const reply = await workspace.checkAnswer(item, attempt);
      if (reply.status !== "pending") return showOutcome(reply);
      flow.phase = "retry";
      message("Hermes ждёт ответ. Можно отправить.");
    };
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
          rejected: "Hermes отклонил ответ",
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
            id: "jobs",
            label: "Расписание",
            run: async () => {
              await workspace.catalog();
              await workspace.loadJobs();
              go("jobs");
            },
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
    if (screen === "jobs")
      return {
        title: "Расписание · Hermes",
        body: workspace.options
          ? `Пояс: ${workspace.options.timezone}`
          : "Время определяет сервер",
        actions: [
          {
            id: "new-job",
            label: "+ Новая задача голосом",
            run: () => compose({ kind: "schedule" }),
          },
          ...workspace.jobs.map((job) => ({
            id: job.id,
            label: `${job.name}\n${job.paused ? "На паузе" : job.nextRunAt || job.state}`,
            run: () => {
              currentJob = job;
              go("job");
            },
          })),
          {
            id: "refresh-jobs",
            label: "Обновить",
            run: async () => {
              await workspace.loadJobs();
              render();
            },
          },
          ...workspace.agents.map((agent) => ({
            id: `profile-${agent.id}`,
            label: `Агент: ${agent.name}`,
            run: async () => {
              await workspace.loadJobs(agent.id);
              render();
            },
          })),
          ...(workspace.pendingSchedule()
            ? [
                {
                  id: "receipt",
                  label: "Проверить операцию",
                  run: async () => {
                    const operation = workspace.pendingSchedule();
                    if (!operation) return;
                    const report = async (result: {
                      status: string;
                      error?: string;
                    }) => {
                      message(
                        result.error
                          ? errorText(result.error)
                          : statusText(result.status),
                      );
                      if (result.status !== "uncertain")
                        await workspace.loadJobs();
                    };
                    const receipt = await workspace.reconcileSchedule(
                      operation.operationId,
                    );
                    if (receipt?.status === "not_found")
                      confirm(
                        "Hermes не получил операцию. Повторить?",
                        async () => {
                          const result = await workspace.retrySchedule(
                            operation.operationId,
                          );
                          go("jobs");
                          await report(result);
                        },
                        "jobs",
                        { label: "Повторить" },
                      );
                    else if (receipt) await report(receipt);
                  },
                },
              ]
            : []),
        ],
      };
    if (screen === "job" && currentJob) {
      const job = currentJob;
      return {
        title: job.name,
        body: `${job.schedule}\n${job.nextRunAt || job.state}`,
        actions: [
          {
            id: "details",
            label: "Прочитать полностью",
            run: () =>
              full(
                `${job.name}\n${job.schedule}\n${job.nextRunAt || job.state}\n${workspace.options?.runNowPolicy || ""}`,
              ),
          },
          {
            id: "pause-job",
            label: job.paused ? "Возобновить" : "Пауза расписания",
            run: () =>
              confirm(
                `${job.paused ? "Возобновить" : "Приостановить"} «${job.name}»?`,
                async () => {
                  await workspace.mutateSchedule(
                    job.paused ? "jobs.resume" : "jobs.pause",
                    { jobId: job.id },
                  );
                  await workspace.loadJobs();
                  go("jobs");
                },
              ),
          },
          {
            id: "run-job",
            label: "Запустить сейчас",
            run: () =>
              confirm(
                `Запустить «${job.name}»?\n${workspace.options?.runNowPolicy || ""}`,
                async () => {
                  await workspace.mutateSchedule("jobs.run", {
                    jobId: job.id,
                  });
                  await workspace.loadJobs();
                  go("jobs");
                },
              ),
          },
          {
            id: "job-history",
            label: "Последний результат",
            run: async () => {
              const result = await workspace.schedule("jobs.history", {
                jobId: job.id,
              });
              const row = result.history?.[0];
              full(
                row
                  ? `${row.status}\n${row.summary || row.reason || "Результат ещё не готов"}`
                  : "Запусков ещё нет",
              );
            },
          },
          { id: "back-jobs", label: "К расписанию", run: () => go("jobs") },
        ],
      };
    }
    if (screen === "pending")
      return {
        title: `Нужен ответ · ${model.order.length}`,
        actions: model.order
          .map((id) => model.snapshot.pending.find((x) => x.id === id)!)
          .filter(Boolean)
          .map((item) => ({
            id: item.id,
            label: `${item.agentName} / ${item.sessionTitle}\n${item.question}\n${item.kind === "permission" ? "Разрешение" : "Вопрос"} · ${remaining(item)}`,
            run: () => openQuestion(item),
          })),
      };
    if (screen === "answered") {
      const next =
        available && relay.online
          ? orderedQuestions(
              model.snapshot.pending.filter((item) => item.id !== questionId),
            )[0]
          : undefined;
      return {
        title: "Ответ принят",
        body: next
          ? `${next.agentName} / ${next.sessionTitle}\n${next.question}`
          : "Список вопросов можно открыть ниже.",
        actions: [
          ...(next
            ? [
                {
                  id: `next:${next.id}`,
                  label: "Следующий вопрос",
                  run: () => {
                    const current = model.snapshot.pending.find(
                      (item) =>
                        item.id === next.id &&
                        item.sessionKey === next.sessionKey,
                    );
                    if (
                      current &&
                      canSend(current) &&
                      relay.online &&
                      available
                    )
                      openQuestion(current);
                    else message("Вопрос больше не актуален");
                  },
                },
              ]
            : []),
          { id: "all-questions", label: "К списку", run: () => go("pending") },
        ],
      };
    }
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
          run: () =>
            full(
              [
                item.permissionDescription,
                item.permissionCommand || item.question,
              ]
                .filter(
                  (line, index, lines) => line && lines.indexOf(line) === index,
                )
                .join("\n\n"),
            ),
        },
        {
          id: "handoff",
          label: "На телефон",
          run: () => handoff("question", item),
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
        bodyLines:
          item.kind === "permission"
            ? [
                `Разрешение · ${remaining(item)}`,
                item.permissionCommand || item.question,
              ]
            : undefined,
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
            id: "handoff",
            label: "На телефон",
            run: () => handoff("result", item),
          },
          {
            id: "chat",
            label: item.sessionKey.includes(":cron-run:")
              ? "Сведения о запуске"
              : "Открыть сессию",
            run: () =>
              item.sessionKey.includes(":cron-run:")
                ? full(
                    `${item.sessionTitle}\nЗадача: ${item.jobId}\nЗапуск: ${item.executionId}\n${item.summary}`,
                  )
                : openChat(item.sessionKey, item.sessionTitle),
          },
          {
            id: "continue",
            label: "Продолжить голосом",
            run: async () => {
              if (item.jobId) {
                const created = await relay.request("sessions.create", {
                  profileId: item.profileId || "default",
                });
                compose({
                  kind: "message",
                  key: created.key,
                  context: `Результат предыдущего запуска:\n${item.summary}\n\nНовая задача:`,
                });
              } else if (item.sessionKey.split(":")[2] === "x")
                message(
                  "Продолжение этой сессии недоступно через её штатный контроллер",
                );
              else compose({ kind: "message", key: item.sessionKey });
            },
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
    if (screen === "chat") {
      const foreign = chatKey.split(":")[2] === "x";
      return {
        title: chatTitle,
        body: foreign
          ? "Продолжение доступно в интерфейсе, где запущена сессия."
          : `Загружено ${messages.length} из ${total}`,
        actions: [
          ...(!foreign
            ? [
                {
                  id: "send",
                  label: "Написать / надиктовать",
                  run: () => compose({ kind: "message", key: chatKey }),
                },
              ]
            : []),
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
    }
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
            void confirm(
              "Скрыть сессию? Вопросы останутся во Входящих.",
              async () => {
                await relay.request("sessions.patch", {
                  key: chatKey,
                  hidden: true,
                });
                await refreshSessions();
                go("sessions");
              },
            ),
        });
      if (s?.actions?.stop)
        acts.push({
          id: "stop",
          label: "Остановить задачу",
          run: () =>
            void confirm("Запросить остановку задачи?", async () => {
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
    if (screen === "confirm" && confirmation) {
      const flow = confirmation;
      return {
        title: "Подтверждение",
        body: flow.text,
        bodyLines: flow.bodyLines,
        actions: [
          {
            id:
              flow.phase === "check"
                ? "check"
                : flow.phase === "retry"
                  ? "retry"
                  : "send",
            label:
              flow.phase === "check"
                ? flow.checkLabel || "Проверить отправку"
                : flow.phase === "retry"
                  ? flow.retryLabel || "Повторить отправку"
                  : flow.label,
            run: flow.phase === "check" && flow.check ? flow.check : flow.send,
          },
          {
            id: "full",
            label: "Прочитать полностью",
            run: () => full(flow.text),
          },
          {
            id: "edit",
            label: "Изменить / перезаписать",
            run: () => go(flow.back),
          },
          { id: "cancel", label: "Отмена", run: () => go(flow.back) },
        ],
      };
    }
    if (
      screen === "compose" &&
      target?.kind === "schedule" &&
      target.recovery
    ) {
      const recovery = target.recovery;
      return {
        title: "Сохранение задачи",
        body: "Проверьте квитанцию Hermes.",
        actions: [
          {
            id: "resume-save",
            label: "Проверить сохранение",
            run: () => {
              confirmation = recovery;
              go("confirm");
            },
          },
          close,
        ],
      };
    }
    if (screen === "compose")
      return {
        title:
          target?.kind === "schedule"
            ? "Новая задача по расписанию"
            : target?.kind === "search"
              ? "Поиск сессий"
              : target?.kind === "rename"
                ? "Название сессии"
                : "Ответ агенту",
        body: draft || "Введите текст на телефоне или включите микрофон.",
        actions: [
          ...(voiceRetry
            ? [
                {
                  id: "retry-voice",
                  label: "Повторить распознавание",
                  run: transcribeRecording,
                },
              ]
            : []),
          ...(draft
            ? [{ id: "use", label: "Продолжить с текстом", run: useDraft }]
            : []),
          {
            id: "voice",
            label: draft
              ? "Перезаписать · до 17 секунд"
              : "Надиктовать · до 17 секунд",
            run: startRecording,
          },
          ...(!draft
            ? [{ id: "use", label: "Продолжить с текстом", run: useDraft }]
            : []),
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
      actions: [close],
    };
  }
  async function reviewSchedule(
    bound: Extract<Target, { kind: "schedule" }>,
    text: string,
  ) {
    if (workspace.pendingSchedule()) {
      go("jobs");
      return message("Проверьте предыдущую операцию расписания.");
    }
    const draftResult = await workspace.schedule("automations.draft", { text });
    const fields = draftResult.fields as ScheduleFields;
    const { preview } = await workspace.schedule("automations.preview", {
      fields,
    });
    const nextRun = preview.nextRuns[0]?.replace("T", " ") || "—";
    const nearest = `Ближайший запуск: ${nextRun}`;
    let operationId: string | undefined;
    async function report(receipt: { status: string; error?: string }) {
      if (receipt.status === "saved") {
        bound.recovery = undefined;
        go("jobs");
        message("Задача сохранена");
        await workspace
          .loadJobs()
          .catch(() => message("Задача сохранена. Список пока недоступен."));
      } else if (receipt.status === "rejected") {
        bound.recovery = undefined;
        go("compose");
        message(errorText(receipt.error || "Hermes отклонил задачу"));
      } else if (
        receipt.status === "not_found" &&
        workspace.pendingSchedule()?.operationId === operationId
      ) {
        flow.phase = "retry";
        message("Hermes не получил операцию. Можно повторить.");
      } else {
        flow.phase = "check";
        message(
          receipt.error
            ? errorText(receipt.error)
            : "Сохранение ещё не подтверждено",
        );
      }
    }
    const flow = confirm(
      `${fields.name}\n${nearest}\n\n${preview.scheduleDisplay} · ${preview.timezone}\n${preview.nextRuns.join("\n")}\n\n${fields.prompt}`,
      async () => {
        try {
          const result = operationId
            ? await workspace.retrySchedule(operationId)
            : await workspace.mutateSchedule(
                "automations.create",
                {
                  fields,
                  reviewHash: preview.reviewHash,
                },
                (id) => {
                  operationId = id;
                },
              );
          await report(result);
        } catch (error) {
          if (error instanceof ScheduleRejected)
            return report({ status: "rejected", error: error.code });
          if (operationId) {
            flow.phase = "check";
            bound.recovery = flow;
          }
          throw error;
        }
      },
      "compose",
      {
        label: "Создать задачу",
        checkLabel: "Проверить сохранение",
        retryLabel: "Повторить сохранение",
        bodyLines: [fields.name, nearest],
      },
    );
    flow.check = async () => {
      const receipt = await workspace.reconcileSchedule(operationId);
      if (receipt) await report(receipt);
    };
  }
  function useDraft() {
    if (target?.kind === "schedule" && target.recovery) {
      confirmation = target.recovery;
      return go("confirm");
    }
    draft = textField.value.trim() || draft;
    if (!draft) return message("Введите или надиктуйте текст");
    if (!target) return;
    voiceRetry = null;
    const boundTarget = target,
      boundDraft =
        target?.kind === "message" && target.context
          ? `${target.context}\n${draft}`
          : draft;
    if (boundTarget.kind === "schedule")
      return reviewSchedule(boundTarget, boundDraft);
    if (boundTarget.kind === "question") {
      questionId = boundTarget.id;
      const item = q();
      if (!item || item.sessionKey !== boundTarget.key)
        return message("Вопрос закрыт");
      questionAnswer({ text: boundDraft }, "compose");
    } else if (boundTarget.kind === "search")
      return refreshSessions(boundDraft).then(() => go("sessions"));
    else
      confirm(
        `Отправить: «${boundDraft}»?`,
        async () => {
          if (boundTarget.kind === "rename") {
            await relay.request("sessions.patch", {
              key: boundTarget.key,
              label: boundDraft,
            });
            await refreshSessions();
            await openChat(boundTarget.key);
          } else {
            await workspace.send(
              boundDraft,
              [],
              boundTarget.key,
              (boundTarget.attempt ??= {}),
            );
            go("sessions");
            await openChat(boundTarget.key).catch(() =>
              message("Сообщение принято. История пока недоступна."),
            );
          }
        },
        "compose",
      );
  }
  let recordTimer: ReturnType<typeof setTimeout> | undefined,
    transcribing = false;
  async function startRecording() {
    if (glasses.phoneInteracting) throw Error("Завершите действие на телефоне");
    await glasses.start();
    voiceRetry = null;
    positions.delete("record");
    go("record");
    recordTimer = setTimeout(() => run(finishRecording), 17000);
  }
  async function finishRecording() {
    if (transcribing || screen !== "record") return;
    transcribing = true;
    clearTimeout(recordTimer);
    try {
      const pcm = await glasses.stop();
      voiceRetry = pcm.length ? pcm : null;
      if (voiceRetry) positions.set("compose", "retry-voice");
      go("compose");
      await transcribeRecording();
    } finally {
      transcribing = false;
    }
  }
  async function transcribeRecording() {
    const pcm = voiceRetry;
    if (!pcm) throw Error("Запись пуста");
    let provider = providerField.value.trim();
    if (!provider) {
      const listing = await relay.request("workspace.stt.providers");
      provider = listing.providers?.find(
        (item: { available?: boolean; id: string }) => item.available,
      )?.id;
    }
    if (!provider) throw Error("На VPS не настроено распознавание речи");
    const reply = await relay.request("workspace.stt.transcribe", {
      wav: wavBase64(pcm),
      provider,
      language: "ru",
    });
    const transcript =
      typeof reply.transcript === "string" ? reply.transcript.trim() : "";
    if (!reply.success || !transcript)
      throw Error(reply.error || "Не удалось распознать речь");
    voiceRetry = null;
    draft = transcript;
    textField.value = draft;
    positions.set("compose", "use");
    message("Проверьте текст перед отправкой");
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
      go(confirmation?.back ?? "question");
      return;
    }
    if (screen === "compose") {
      voiceRetry = null;
      go(
        target?.kind === "question"
          ? "question"
          : target?.kind === "schedule"
            ? "jobs"
            : "sessions",
      );
      return;
    }
    if (screen === "question" || screen === "answered") {
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
    if (screen === "home") run(() => glasses.exit());
    else go("home");
  }
  function clearNotification() {
    notification = null;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = null;
  }
  function showNotification() {
    if (
      notification ||
      glasses.isRecording ||
      glasses.phoneInteracting ||
      ["record", "confirm", "compose", "read", "question", "answered"].includes(
        screen,
      ) ||
      busy
    )
      return;
    notification = null;
    while (notificationQueue.length && !notification) {
      const item = notificationQueue.shift()!;
      if (
        "question" in item
          ? model.snapshot.pending.some((x) => x.id === item.id) &&
            canSend(item)
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
  async function reconcileOperations() {
    const generation = connectionGeneration,
      store = receipts;
    if (!store) return;
    const checks = await Promise.allSettled(
      store.list().map(async (pending) => {
        const receipt = await relay.request(
          "inbox.operation",
          {
            operationId: pending.operationId,
          },
          { acceptStatus: true },
        );
        if (generation !== connectionGeneration) return "";
        if (
          ["accepted", "rejected", "already_answered", "expired"].includes(
            receipt.status,
          )
        ) {
          store.clear(pending.operationId);
          return receipt.status === "accepted"
            ? "Предыдущий ответ принят Hermes"
            : receipt.error || statusLabel(receipt.status);
        }
        const current = await relay.request("inbox.get", {
          id: pending.id,
          sessionKey: pending.sessionKey,
        });
        if (generation !== connectionGeneration) return "";
        if (
          ["not_found", "expired", "already_answered"].includes(current.status)
        ) {
          store.clear(pending.operationId);
          return "Предыдущий запрос больше не активен. Повторной отправки не было.";
        }
        return current.status === "pending"
          ? "Предыдущая отправка не подтверждена. Вопрос ещё ожидает ответа."
          : "Источник вопросов недоступен. Предыдущая отправка ещё не подтверждена.";
      }),
    );
    if (generation !== connectionGeneration) return;
    const notices = checks.flatMap((check) =>
      check.status === "fulfilled" && check.value ? [check.value] : [],
    );
    if (notices.length) message([...new Set(notices)].join("\n"));
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
  glasses.onDevice = () => {
    shownAction = "";
    render();
  };
  relay.onSnapshot = applySnapshot;
  relay.onError = message;
  relay.onState = (online) => {
    app.querySelector("#connection")!.textContent = online
      ? "VPS подключён"
      : "Нет связи";
    if (online) void reconcileOperations().catch(() => {});
    else available = false;
    render();
  };
  function actionKey() {
    return JSON.stringify([
      screen,
      notification?.id,
      questionId,
      chatKey,
      currentJob?.id,
      confirmation?.id,
      screen === "read" ? readPage : null,
      current.actions[selected]?.id,
    ]);
  }
  function handleInput(input: Input, device: boolean) {
    const previousTap = lastTap;
    if (device && input === "select") lastTap = performance.now();
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
      if (device && (!glasses.displayReady || shownAction !== actionKey()))
        return;
      // A quick second event must not confirm the screen opened by the first.
      if (
        device &&
        screen === "confirm" &&
        action &&
        ["send", "retry"].includes(action.id) &&
        lastTap - previousTap < 250
      )
        return;
      if (action) run(action.run);
      return;
    }
    if (screen === "read" && !notification) {
      readPage = Math.max(
        0,
        Math.min(
          readChunks(readText).length - 1,
          readPage + (input === "up" ? -1 : 1),
        ),
      );
      render(false);
      return;
    }
    selected = Math.max(
      0,
      Math.min(
        current.actions.length - 1,
        selected + (input === "up" ? -1 : 1),
      ),
    );
    if (!notification)
      positions.set(screen, current.actions[selected]?.id || "");
    render(false);
  }
  glasses.onInput = (input) => handleInput(input, true);
  glasses.onMenu = (id) => {
    if (busy || ["record", "confirm"].includes(screen)) return;
    if (id === 101) go("pending");
    else if (id === 102)
      run(async () => {
        await refreshSessions();
        go("sessions");
      });
    else if (id === 104)
      run(async () => {
        await workspace.catalog();
        await workspace.loadJobs();
        go("jobs");
      });
    else if (id === 103 && screen === "chat") go("menu");
    else go("home");
  };
  glasses.onError = (text) => {
    if (notice !== text) message(text);
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
    c.fillText(clip(v.title, 552, 20), 12, 25);
    c.fillRect(12, 35, 552, 1);
    let y = 60;
    if (v.body) {
      c.font = "19px 'Noto Sans'";
      const lines = v.bodyLines ?? wrap(v.body, 548, 19);
      const limit = screen === "read" ? 6 : 2;
      for (const [index, line] of lines.slice(0, limit).entries()) {
        const truncated = index === limit - 1 && lines.length > limit;
        c.fillText(clip(truncated ? line + " …" : line, 548, 19), 12, y);
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
      c.fillText(
        (i === selected ? "> " : "  ") + clip(lines[0], 510, 20),
        12,
        y,
      );
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
      clip(
        busy
          ? screen === "confirm" && confirmation?.phase !== "check"
            ? "Отправляем…"
            : "Ожидаю ответ сервера…"
          : notice ||
              (screen === "read"
                ? "Свайп — страница · двойное касание — назад"
                : `${Math.min(selected + 1, v.actions.length)}/${v.actions.length} · двойное касание — ${screen === "home" ? "выход" : "назад"}`),
        552,
        13,
      ),
      12,
      282,
    );
    return canvas;
  }
  function render(restore = true) {
    current = view();
    if (notification) selected = 0;
    else if (restore) {
      const id = positions.get(screen),
        i = current.actions.findIndex((x) => x.id === id);
      if (i >= 0) selected = i;
    }
    selected = Math.min(
      Math.max(selected, 0),
      Math.max(0, current.actions.length - 1),
    );
    if (!notification)
      positions.set(screen, current.actions[selected]?.id || "");
    app.querySelector("#title")!.textContent = current.title;
    app.querySelector("#body")!.textContent = current.body || "";
    app.querySelector("#notice")!.textContent = notice;
    const actions = app.querySelector("#actions")!;
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
    app.querySelector<HTMLFormElement>("#text-form")!.hidden =
      screen !== "compose" ||
      (target?.kind === "schedule" && Boolean(target.recovery));
    textField.disabled = busy;
    const canvas = draw(current);
    document
      .querySelector<HTMLCanvasElement>("#display")!
      .getContext("2d")!
      .drawImage(canvas, 0, 0);
    const key = actionKey();
    glasses.paint(canvas, () => {
      shownAction = key;
    });
    if (["home", "pending", "completed", "sessions"].includes(screen))
      localStorage.setItem(
        uiKey(),
        JSON.stringify({ screen, positions: [...positions] }),
      );
  }
  app.querySelector("#controls")!.addEventListener("click", (event) => {
    const input = (event.target as HTMLElement).dataset.input;
    if (input) handleInput(input as Input, false);
  });
  app.querySelector("#connect")!.addEventListener("submit", (event) => {
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
      (app.querySelector("#setup") as HTMLDetailsElement).open = false;
    } catch (e) {
      message((e as Error).message);
    }
  });
  textField.addEventListener("input", () => {
    draft = textField.value;
    render();
  });
  app.querySelector("#text-form")!.addEventListener("submit", (event) => {
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
    voiceRetry = null;
    void glasses
      .stop()
      .catch((error) => glasses.onError(String(error.message)));
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

  return {
    reset: resetConnection,
    canSwitch: () => !busy && !["record", "confirm"].includes(screen),
    show: async (item: {
      kind: "chat" | "question" | "result";
      key: string;
      id?: string;
      title?: string;
    }) => {
      if (busy || ["record", "confirm", "compose"].includes(screen))
        throw Error("Завершите действие на очках");
      if (item.kind === "chat") await openChat(item.key, item.title);
      else if (item.kind === "question") {
        const question = model.snapshot.pending.find(
          (row) => row.id === item.id && row.sessionKey === item.key,
        );
        if (!question) throw Error("Вопрос уже закрыт");
        openQuestion(question);
      } else {
        completionId = item.id || "";
        go("result");
      }
    },
  };
}

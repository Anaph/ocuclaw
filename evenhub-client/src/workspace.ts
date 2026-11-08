import { Relay } from "./transport";
import { endpointScope, randomId, ReceiptStore } from "./protocol";
import type { Answer, Question, Session, InboxModel } from "./model";
export interface Agent {
  id: string;
  name: string;
  model?: { primary: string };
}
export interface Model {
  id: string;
  provider: string;
  name?: string;
}
export interface Message {
  id?: string | number;
  role: string;
  content: unknown;
  createdAt?: number;
}
export interface Job {
  id: string;
  name: string;
  state: string;
  paused?: boolean;
  schedule: string;
  nextRunAt?: string;
  lastExecution?: Execution;
  lastStatus?: string;
  fields?: Record<string, unknown>;
  revision?: string;
}
export interface Execution {
  id: string;
  jobId: string;
  status: string;
  delivery?: string;
  needsAnswer?: boolean;
  stopRequested?: boolean;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  sessionKey?: string;
  reason?: string;
}
export interface ScheduleFields {
  name: string;
  prompt: string;
  schedule: string;
  model?: string;
  provider?: string;
  deliver?: string;
}
export interface ScheduleOptions {
  serverNowMs: number;
  serverLocalTime?: string;
  timezone: string;
  supported: boolean;
  reason?: string;
  missedPolicy: string;
  parallelPolicy: string;
  runNowPolicy: string;
  stopSupported: boolean;
}
export class Workspace {
  scope = "";
  generation = 0;
  agents: Agent[] = [];
  models: Model[] = [];
  sessions: Session[] = [];
  messages: Message[] = [];
  chatKey = "";
  nextBeforeId: string | number | null = null;
  hasMore = false;
  jobs: Job[] = [];
  history: Execution[] = [];
  historyCursor: string | null = null;
  profile = "default";
  options: ScheduleOptions | null = null;
  liveText = "";
  liveRun = "";
  liveSeq = -1;
  onChange = () => {};
  private chatEpoch = 0;
  private catalogProfile = "";
  constructor(
    readonly relay: Relay,
    readonly inbox: InboxModel,
    private storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    > = localStorage,
  ) {
    relay.observe({
      snapshot: (snapshot) => {
        const allowed = snapshot.authorizedNamespaces;
        if (!Array.isArray(allowed)) return;
        let removed = false;
        const oldSessions = this.sessions.length,
          oldAgents = this.agents.length;
        this.sessions = this.sessions.filter((row) =>
          allowed.includes(row.key.split(":")[1]),
        );
        this.agents = this.agents.filter((row) =>
          allowed.includes(row.id === "default" ? "main" : row.id),
        );
        if (this.chatKey && !allowed.includes(this.chatKey.split(":")[1])) {
          removed = true;
          this.chatEpoch++;
          this.chatKey = "";
          this.messages = [];
          this.liveText = "";
        }
        if (
          !allowed.includes(this.profile === "default" ? "main" : this.profile)
        ) {
          removed = Boolean(
            this.jobs.length || this.history.length || this.options,
          );
          this.jobs = [];
          this.history = [];
          this.options = null;
          this.profile = "default";
        }
        if (
          removed ||
          oldSessions !== this.sessions.length ||
          oldAgents !== this.agents.length
        )
          this.onChange();
      },
      chat: (frame) => {
        const data = frame.data;
        if (data.sessionKey !== this.chatKey) return;
        if (frame.event === "streaming") {
          const seq = typeof data.seq === "number" ? data.seq : 0;
          if (data.runId !== this.liveRun) {
            this.liveRun = data.runId;
            this.liveSeq = -1;
          }
          if (seq < this.liveSeq) return;
          this.liveSeq = seq;
          this.liveText = String(data.text ?? data.content ?? "");
          this.onChange();
        } else if (
          frame.event === "message" ||
          ["complete", "completed", "end", "error"].includes(data.phase)
        )
          void this.openChat(this.chatKey, false).catch(() => {});
      },
    });
  }
  reset(address: string) {
    this.generation++;
    this.chatEpoch++;
    this.scope = endpointScope(address);
    this.agents = [];
    this.catalogProfile = "";
    this.models = [];
    this.sessions = [];
    this.messages = [];
    this.chatKey = "";
    this.jobs = [];
    this.history = [];
    this.options = null;
    this.profile = "default";
    this.nextBeforeId = null;
    this.hasMore = false;
    this.liveText = "";
    this.liveRun = "";
    this.liveSeq = -1;
  }
  async request<T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const generation = this.generation;
    const result = await this.relay.request(method, params);
    if (generation !== this.generation) throw Error("Подключение изменилось");
    if (result?.error && !result.status) throw Error(errorText(result.error));
    return result;
  }
  private draftKey(key: string) {
    return `ocuclaw.draft:${encodeURIComponent(this.scope)}:${encodeURIComponent(key)}`;
  }
  draft(key = this.chatKey) {
    return this.storage.getItem(this.draftKey(key)) || "";
  }
  saveDraft(text: string, key = this.chatKey) {
    if (key) this.storage.setItem(this.draftKey(key), text);
  }
  async catalog(profileId = "default") {
    const result = await this.request("workspace.catalog", { profileId });
    this.catalogProfile = profileId;
    this.agents = result.agents || [];
    this.models = result.models || [];
    this.onChange();
  }
  async list(search = "", includeHidden = false) {
    const result = await this.request("sessions.list", {
      search,
      includeHidden,
    });
    this.sessions = result.sessions || [];
    this.onChange();
  }
  async create(profileId: string, model: string, provider: string) {
    const result = await this.request("sessions.create", {
      profileId,
      ...(model ? { model, provider } : {}),
    });
    await this.openChat(result.key);
    return result.key as string;
  }
  async openChat(key: string, subscribe = true) {
    const epoch = ++this.chatEpoch;
    const data = await this.request(
      subscribe ? "chat.subscribe" : "chat.history",
      { sessionKey: key, limit: 30 },
    );
    if (epoch !== this.chatEpoch) return;
    const changed = this.chatKey !== key;
    this.chatKey = key;
    this.messages = data.messages || [];
    this.hasMore = data.hasMore === true;
    this.nextBeforeId = data.nextBeforeId ?? null;
    if (
      changed ||
      (this.liveText &&
        this.messages.some(
          (x) =>
            x.role === "assistant" &&
            messageText(x.content).includes(this.liveText),
        ))
    ) {
      this.liveText = "";
      this.liveSeq = -1;
    }
    this.onChange();
  }
  async older() {
    if (!this.hasMore || this.nextBeforeId === null) return;
    const key = this.chatKey,
      epoch = this.chatEpoch;
    const data = await this.request("chat.history", {
      sessionKey: key,
      limit: 30,
      beforeId: this.nextBeforeId,
    });
    if (epoch !== this.chatEpoch || key !== this.chatKey) return;
    const ids = new Set(this.messages.map((x) => x.id));
    this.messages = [
      ...(data.messages || []).filter(
        (x: Message) => x.id === undefined || !ids.has(x.id),
      ),
      ...this.messages,
    ];
    this.hasMore = data.hasMore === true;
    this.nextBeforeId = data.nextBeforeId ?? null;
    this.onChange();
  }
  async renewChat() {
    if (this.chatKey)
      await this.request("chat.subscribe", {
        sessionKey: this.chatKey,
        limit: 30,
      });
  }
  async upload(file: File) {
    const limits = this.relay.capabilities.uploads;
    if (!limits || file.size > limits.fileBytes || file.size === 0)
      throw Error("Файл превышает лимит сервера или пуст");
    const row = await this.request("uploads.begin", {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
    });
    try {
      for (let offset = 0; offset < file.size; offset += row.chunkBytes) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + row.chunkBytes).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await this.request("uploads.chunk", {
          id: row.id,
          offset,
          content: btoa(binary),
        });
      }
      return row.id as string;
    } catch (error) {
      void this.request("uploads.cancel", { id: row.id }).catch(() => {});
      throw error;
    }
  }
  async send(text: string, files: File[]) {
    const key = this.chatKey;
    if (!key || (!text.trim() && !files.length))
      throw Error("Добавьте сообщение или вложение");
    const operationKey = `ocuclaw.send:${encodeURIComponent(this.scope)}:${encodeURIComponent(key)}`;
    const prior = JSON.parse(this.storage.getItem(operationKey) || "null");
    if (prior) {
      const receipt = await this.checkSend();
      if (receipt?.status === "accepted") return receipt;
      if (receipt?.status !== "not_found")
        throw Error(
          "Предыдущая отправка не подтверждена. Проверьте историю и квитанцию.",
        );
      if (prior.text !== text || (prior.hadFiles && !files.length))
        throw Error(
          "Восстановите исходный текст и вложения перед повтором неподтверждённой отправки.",
        );
    }
    const uploads = [];
    for (const file of files) uploads.push(await this.upload(file));
    const operationId = prior?.id || randomId();
    this.storage.setItem(
      operationKey,
      JSON.stringify({ id: operationId, text, hadFiles: files.length > 0 }),
    );
    const result = await this.request("agent", {
      sessionKey: key,
      message: text,
      idempotencyKey: operationId,
      uploadIds: uploads,
    });
    if (result.status && result.status !== "accepted") {
      if (result.status !== "uncertain") this.storage.removeItem(operationKey);
      throw Error(errorText(result.error || result.status));
    }
    this.storage.removeItem(operationKey);
    this.saveDraft("", key);
    await this.openChat(key, false);
    return result;
  }
  pendingSend() {
    try {
      return JSON.parse(
        this.storage.getItem(
          `ocuclaw.send:${encodeURIComponent(this.scope)}:${encodeURIComponent(this.chatKey)}`,
        ) || "null",
      );
    } catch {
      return null;
    }
  }
  async checkSend() {
    const pending = this.pendingSend();
    if (!pending) return null;
    const key = this.chatKey;
    const receipt = await this.request("workspace.send.receipt", {
      sessionKey: key,
      operationId: pending.id,
    });
    if (receipt.status === "accepted") {
      this.storage.removeItem(
        `ocuclaw.send:${encodeURIComponent(this.scope)}:${encodeURIComponent(key)}`,
      );
      this.saveDraft("", key);
      await this.openChat(key, false);
    }
    return receipt;
  }
  async answer(item: Question, answer: Answer) {
    const current = await this.request("inbox.get", {
      id: item.id,
      sessionKey: item.sessionKey,
    });
    if (current.status !== "pending") throw Error(statusText(current.status));
    const store = new ReceiptStore(sessionStorage, this.scope),
      operationId = randomId();
    store.save({ id: item.id, sessionKey: item.sessionKey, operationId });
    const result = await this.request("inbox.answer", {
      id: item.id,
      sessionKey: item.sessionKey,
      operationId,
      answer,
    });
    if (result.status !== "uncertain") store.clear();
    if (result.status !== "accepted") throw Error(statusText(result.status));
  }
  async schedule(method: string, payload: Record<string, unknown> = {}) {
    return this.request(method, { ...payload, profileId: this.profile });
  }
  async loadJobs(profile = this.profile) {
    this.profile = profile;
    if (this.catalogProfile !== profile) await this.catalog(profile);
    const generation = this.generation;
    const options = await this.schedule("automations.options");
    const data = options.supported
      ? await this.schedule("jobs.list")
      : { jobs: [] };
    if (generation !== this.generation || profile !== this.profile) return;
    this.options = options;
    this.jobs = data.jobs || [];
    this.onChange();
  }
  private receiptKey() {
    return `ocuclaw.scheduleOperation:${encodeURIComponent(this.scope)}:${this.profile}`;
  }
  async mutateSchedule(operation: string, params: Record<string, unknown>) {
    if (this.storage.getItem(this.receiptKey()))
      throw Error("Сначала проверьте предыдущую операцию расписания");
    const operationId = randomId();
    this.storage.setItem(
      this.receiptKey(),
      JSON.stringify({ operationId, operation, params }),
    );
    const result = await this.schedule(operation, { ...params, operationId });
    if (result.status !== "uncertain")
      this.storage.removeItem(this.receiptKey());
    if (result.status === "rejected")
      throw Error(errorText(result.error || "Hermes отклонил изменение"));
    if (result.status === "uncertain")
      throw Error("Результат неизвестен. Проверьте операцию перед повтором.");
    return result;
  }
  async retrySchedule() {
    const saved = JSON.parse(this.storage.getItem(this.receiptKey()) || "null");
    if (!saved) return;
    const receipt = await this.schedule("automations.receipt", {
      operationId: saved.operationId,
    });
    if (receipt.status !== "not_found")
      throw Error("Операция уже известна Hermes; повтор не отправлен");
    const result = await this.schedule(saved.operation, {
      ...saved.params,
      operationId: saved.operationId,
    });
    if (result.status !== "uncertain")
      this.storage.removeItem(this.receiptKey());
    if (result.error) throw Error(result.error);
    return result;
  }
  async reconcileSchedule() {
    const saved = JSON.parse(this.storage.getItem(this.receiptKey()) || "null");
    if (!saved) return null;
    const result = await this.schedule("automations.receipt", {
      operationId: saved.operationId,
    });
    if (result.status !== "uncertain" && result.status !== "not_found")
      this.storage.removeItem(this.receiptKey());
    return result;
  }
}
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((x) =>
        typeof x?.text === "string"
          ? x.text
          : x?.type === "image_url"
            ? "[Изображение]"
            : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}
export function statusText(status: string) {
  return (
    (
      {
        accepted: "Принято",
        scheduled: "По расписанию",
        running: "Работает",
        claimed: "Запуск принят",
        completed: "Готово",
        failed: "Ошибка",
        error: "Ошибка",
        paused: "На паузе",
        unknown: "Нет подтверждения",
        delivered: "Доставлено",
        not_configured: "Сохранено в Hermes",
        queued: "В очереди доставки",
        suppressed: "Доставка отключена",
        expired: "Срок вопроса истёк",
        already_answered: "Ответ уже дан",
        not_found: "Запрос не найден",
        source_unavailable: "Hermes недоступен",
        uncertain: "Отправка не подтверждена",
      } as Record<string, string>
    )[status] || status
  );
}
export function scheduleExpression(
  kind: string,
  date: string,
  time: string,
  days: string[],
  interval: string,
  cron: string,
) {
  if (kind === "once") return `${date}T${time}:00`;
  if (kind === "interval") return `every ${interval}`;
  if (kind === "cron") return cron.trim();
  const [hours, minutes] = time.split(":").map(Number);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours > 23 ||
    minutes > 59
  )
    throw Error("Укажите время");
  if (kind === "weekly" && !days.length) throw Error("Выберите дни недели");
  return `${minutes} ${hours} * * ${kind === "weekly" ? days.join(",") : "*"}`;
}

export function errorText(code: string): string {
  return (
    (
      {
        stale_edit:
          "Задача изменилась в другом интерфейсе. Откройте её заново.",
        preview_expired: "Проверка расписания устарела. Проверьте его ещё раз.",
        job_not_found: "Задача больше не существует",
        resume_before_run: "Сначала возобновите задачу на паузе",
        execution_not_running: "Этот запуск уже завершился",
        invalid_fields: "Проверьте название, инструкцию и расписание",
        schedule_has_no_future_run: "Расписание не содержит будущих запусков",
        hermes_workspace_api_unavailable:
          "На сервере недоступен публичный Workspace API Hermes",
        native_job_lock_unavailable:
          "Хранилище Hermes занято. Обновите состояние перед повтором",
      } as Record<string, string>
    )[code] || code
  );
}
export interface ScheduleForm {
  kind: string;
  date: string;
  time: string;
  days: string[];
  interval: string;
  cron: string;
}
export function scheduleForm(expression: string): ScheduleForm {
  const form = {
    kind: "cron",
    date: "",
    time: "09:00",
    days: [] as string[],
    interval: "2h",
    cron: expression,
  };
  const interval = /^every (\d+[mhd])$/.exec(expression);
  const once = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)/.exec(expression);
  const simple = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6](?:,[0-6])*|\*)$/.exec(
    expression,
  );
  if (interval) {
    form.kind = "interval";
    form.interval = interval[1];
  } else if (once) {
    form.kind = "once";
    form.date = once[1];
    form.time = once[2];
  } else if (simple) {
    form.kind = simple[3] === "*" ? "daily" : "weekly";
    form.time = simple[2].padStart(2, "0") + ":" + simple[1].padStart(2, "0");
    form.days = simple[3] === "*" ? [] : simple[3].split(",");
  }
  return form;
}

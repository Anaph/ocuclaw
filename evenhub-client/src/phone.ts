import { marked } from "marked";
import DOMPurify from "dompurify";
import { AudioInputSource } from "@evenrealities/even_hub_sdk";
import {
  Workspace,
  errorText,
  messageText,
  scheduleForm,
  serializeSchedule,
  type ScheduleForm,
  statusText,
  type ScheduleFields,
  type Job,
} from "./workspace";
import {
  sessionStatus,
  type InboxModel,
  type Question,
  type Answer,
} from "./model";
import { endpointScope } from "./protocol";
import type { Relay } from "./transport";
import { wavBase64, type Glasses } from "./glasses";
type Tab = "chats" | "inbox" | "schedule" | "settings";
type Hud = {
  reset: (scope: string) => void;
  canSwitch: () => boolean;
  show: (item: {
    kind: "chat" | "question" | "result";
    key: string;
    id?: string;
    title?: string;
  }) => Promise<void>;
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const markdown = (text: string) =>
  DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ["img", "style", "input", "form"],
    FORBID_ATTR: ["style"],
  });
const date = (value?: string) =>
  value ? value.replace("T", " ").replace(/\.\d+/, "") : "—";
const readSchedule = (data: FormData): ScheduleForm => ({
  kind: String(data.get("kind")),
  date: String(data.get("date")),
  time: String(data.get("time")),
  days: data.getAll("days").map(String),
  interval: String(data.get("interval")),
  cron: String(data.get("cron")),
});
export class PhoneApp {
  readonly data: Workspace;
  private tab: Tab = "chats";
  private search = "";
  private hidden = false;
  private inboxTab = "pending";
  private question: Question | null = null;
  private renameSession: { key: string; title: string } | null = null;
  private selected = new Set<number>();
  private attachmentDrafts = new Map<string, File[]>();
  private get files() {
    const key = this.data.scope + this.data.chatKey;
    let files = this.attachmentDrafts.get(key);
    if (!files) {
      files = [];
      this.attachmentDrafts.set(key, files);
    }
    return files;
  }
  private set files(files: File[]) {
    this.attachmentDrafts.set(this.data.scope + this.data.chatKey, files);
  }
  private busy = false;
  private syncing = false;
  private notice = "";
  private recording = false;
  private recordTimer: ReturnType<typeof setTimeout> | undefined;
  private jobFilter = "all";
  private job: Job | null = null;
  private preview: any = null;
  private fields: ScheduleFields | null = null;
  private editorState: ScheduleForm | null = null;
  private historyJob = "";
  private showNew = false;
  private creationProfile = "default";
  private creationModel = "";
  private confirmation: { text: string; action: () => Promise<void> } | null =
    null;
  private panel: HTMLElement;
  private status: HTMLElement;
  private toast: HTMLElement;
  private bottom: HTMLElement;
  private composer?: HTMLTextAreaElement;
  private dictationTarget: "chat" | "answer" | "schedule" = "chat";
  private answerDraft = "";
  private contextIds = new Set<string>();
  private showContext = false;
  constructor(
    private root: HTMLElement,
    private relay: Relay,
    private glasses: Glasses,
    private inbox: InboxModel,
    private hud: Hud,
    private hudRoot: HTMLElement,
  ) {
    this.data = new Workspace(relay, inbox);
    root.innerHTML = `<main class="phone"><header><div><span class="brand">OCUCLAW</span><small>Hermes · Even Hub</small></div><div id="phone-status" role="status"></div></header><p id="phone-notice" role="status"></p><section id="phone-content"></section><nav class="bottom-nav" aria-label="Разделы"></nav></main>`;
    this.panel = root.querySelector("#phone-content")!;
    this.status = root.querySelector("#phone-status")!;
    this.toast = root.querySelector("#phone-notice")!;
    this.bottom = root.querySelector(".bottom-nav")!;
    this.data.onChange = () => this.render();
    relay.observe({
      snapshot: () => {
        if (
          this.tab === "inbox" &&
          !this.fields &&
          !this.recording &&
          !this.confirmation
        )
          this.render();
      },
      error: (text) => this.message(text),
      state: (online) => {
        this.render();
        if (online) void this.syncWorkspace(true);
      },
    });
    const onDevice = glasses.onDevice;
    glasses.onDevice = (connected) => {
      onDevice(connected);
      this.render();
    };
    setInterval(() => {
      if (relay.online && !this.busy && !this.syncing)
        void this.syncWorkspace(false);
    }, 15000);
    window.addEventListener("pagehide", () => {
      if (this.recording) void this.stopRecording(true);
    });
    this.render();
    void this.restoreConnection();
  }
  private message(text: string) {
    this.notice = text;
    this.toast.textContent = text;
  }
  private async syncWorkspace(reconnected: boolean) {
    const generation = this.data.generation;
    this.syncing = true;
    const requests = [this.data.refreshChat(undefined, true)];
    if (reconnected || (this.tab === "chats" && !this.data.chatKey))
      requests.push(this.data.list(this.search, this.hidden));
    if (
      this.tab === "schedule" &&
      (reconnected || (!this.fields && !this.historyJob))
    )
      requests.push(this.data.loadJobs());
    else if (reconnected)
      requests.push(this.data.catalog(this.creationProfile));
    const results = await Promise.allSettled(requests);
    if (generation !== this.data.generation) return;
    this.syncing = false;
    const failure = results.find((result) => result.status === "rejected");
    if (reconnected && failure) this.message(failure.reason.message);
  }
  private async run(action: () => void | Promise<unknown>) {
    if (this.busy) return;
    this.busy = true;
    this.panel.setAttribute("aria-busy", "true");
    try {
      await action();
    } catch (error) {
      this.message((error as Error).message);
    } finally {
      this.busy = false;
      this.panel.removeAttribute("aria-busy");
      this.render();
    }
  }
  private button(
    label: string,
    action: () => void | Promise<unknown>,
    className = "",
  ) {
    const button = document.createElement("button");
    button.textContent = label;
    button.className = className;
    button.disabled = this.recording && !label.includes("Завершить диктовку");
    button.onclick = () => void this.run(action);
    return button;
  }
  private bind(selector: string, action: () => void | Promise<unknown>) {
    this.panel
      .querySelector(selector)
      ?.addEventListener("click", () => void this.run(action));
  }
  private confirm(text: string, action: () => Promise<void>) {
    this.confirmation = { text, action };
    this.render();
  }
  private async refreshInbox() {
    const snapshot = await this.data.request("inbox.snapshot");
    this.relay.onSnapshot(snapshot);
    this.render();
  }
  private async restoreConnection() {
    try {
      if (new URLSearchParams(location.search).get("preview") === "1") return;
      const wait = Date.now();
      while (!this.glasses.bridge && Date.now() - wait < 8000)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const raw =
        await this.glasses.bridge?.getLocalStorage("ocuclaw.connection");
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.address && saved.token && !this.data.scope)
          this.connect(saved.address, saved.token);
      }
    } catch {
      this.message(
        "Сохранённое подключение недоступно. Подключитесь в настройках.",
      );
    }
  }
  private connect(address: string, token: string) {
    if (this.recording || !this.hud.canSwitch())
      throw Error("Завершите запись или подтверждение на очках");
    const scope = endpointScope(address);
    if (!token.trim()) throw Error("Введите ключ подключения");
    this.data.reset(address);
    this.hud.reset(scope);
    this.question = null;
    this.renameSession = null;
    this.fields = null;
    this.job = null;
    this.attachmentDrafts.clear();
    this.preview = null;
    this.confirmation = null;
    this.historyJob = "";
    this.contextIds.clear();
    this.showContext = false;
    this.search = "";
    this.hidden = false;
    this.showNew = false;
    this.tab = "chats";
    localStorage.setItem("ocuclaw.server", address);
    this.relay.connect(address, token);
  }
  private navigate(tab: Tab) {
    if (this.recording) return this.message("Завершите диктовку");
    this.tab = tab;
    this.question = null;
    this.renameSession = null;
    this.fields = null;
    this.historyJob = "";
    this.confirmation = null;
    return this.run(async () => {
      if (tab === "schedule" && this.relay.online) await this.data.loadJobs();
      if (tab === "chats" && this.relay.online)
        await this.data.list(this.search, this.hidden);
    });
  }
  private render() {
    this.glasses.phoneInteracting = Boolean(
      this.confirmation || this.recording,
    );
    this.status.textContent = `${this.relay.online ? "● Hermes" : "○ Нет связи"} · ${this.glasses.displayReady ? "G2 подключены" : "Без очков"}`;
    this.toast.textContent = this.notice;
    this.bottom.replaceChildren();
    for (const [id, label] of [
      ["chats", "Чаты"],
      ["inbox", "Входящие"],
      ["schedule", "Расписание"],
      ["settings", "Настройки"],
    ] as const) {
      const button = this.button(
        label,
        () => this.navigate(id),
        this.tab === id ? "active" : "",
      );
      button.onclick = () => void this.navigate(id);
      this.bottom.append(button);
    }
    // Preserve unsent text and selection across stream updates.
    const connectionForm =
      this.panel.querySelector<HTMLFormElement>("#phone-connect");
    const connectionDraft = connectionForm
      ? new FormData(connectionForm)
      : null;
    const focus = document.activeElement as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const active =
      focus?.id && this.panel.contains(focus)
        ? { id: focus.id, start: focus.selectionStart, end: focus.selectionEnd }
        : null;
    const scroll = this.panel.querySelector(".messages")?.scrollTop;
    const nearBottom = (() => {
      const el = this.panel.querySelector(".messages");
      return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    })();
    if (this.confirmation) this.renderConfirmation();
    else if (this.renameSession) this.renderRename();
    else if (this.tab === "chats") this.renderChats();
    else if (this.tab === "inbox") this.renderInbox();
    else if (this.tab === "schedule") this.renderSchedule();
    else this.renderSettings();
    if (connectionDraft) {
      const form = this.panel.querySelector<HTMLFormElement>("#phone-connect");
      if (form) {
        for (const name of ["url", "token"]) {
          (form.elements.namedItem(name) as HTMLInputElement).value = String(
            connectionDraft.get(name) || "",
          );
        }
        (form.elements.namedItem("remember") as HTMLInputElement).checked =
          Boolean(connectionDraft.get("remember"));
      }
    }
    if (active) {
      const next = this.panel.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >(`#${active.id}`);
      next?.focus();
      if (next && next.type !== "number")
        try {
          next.setSelectionRange(active.start, active.end);
        } catch {}
    }
    const messages = this.panel.querySelector(".messages");
    if (messages) {
      messages.scrollTop = nearBottom ? messages.scrollHeight : (scroll ?? 0);
    }
    this.panel
      .querySelectorAll<HTMLAnchorElement>(".markdown a")
      .forEach((link) => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      });
    this.panel.querySelectorAll("pre").forEach((pre) =>
      pre.append(
        this.button(
          "Копировать",
          async () => {
            await navigator.clipboard.writeText(
              pre.querySelector("code")?.textContent || "",
            );
            this.message("Код скопирован");
          },
          "copy-code",
        ),
      ),
    );
  }
  private renderConfirmation() {
    const pending = this.confirmation!;
    this.panel.innerHTML = `<section class="card"><h1>Подтверждение</h1><p class="preserve">${esc(pending.text)}</p><div class="row" id="confirm-actions"></div></section>`;
    const actions = this.panel.querySelector("#confirm-actions")!;
    actions.append(
      this.button("Подтвердить", async () => {
        await pending.action();
        this.confirmation = null;
      }),
      this.button("Изменить / Назад", () => {
        this.confirmation = null;
      }),
    );
  }
  private renderChats() {
    if (this.showNew) {
      this.panel.innerHTML = `<h1>Новый чат</h1><form id="new-chat"><label>Агент<select name="profile">${this.data.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === this.creationProfile ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><label>Модель<select name="model"><option value="">Настройка Hermes</option>${this.modelOptions(this.creationModel)}</select></label><button>Создать чат</button></form><button id="cancel-new">Назад</button>`;
      this.panel.querySelector<HTMLSelectElement>(
        "#new-chat [name=profile]",
      )!.onchange = (event) => {
        this.creationProfile = (event.target as HTMLSelectElement).value;
        this.creationModel = "";
        void this.run(() => this.data.catalog(this.creationProfile));
      };
      this.panel.querySelector<HTMLSelectElement>(
        "#new-chat [name=model]",
      )!.onchange = (event) =>
        (this.creationModel = (event.target as HTMLSelectElement).value);
      this.panel
        .querySelector("#new-chat")!
        .addEventListener("submit", (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget as HTMLFormElement);
          const selected = this.data.models.find(
            (m) => `${m.provider}/${m.id}` === form.get("model"),
          );
          void this.run(async () => {
            await this.data.create(
              String(form.get("profile")),
              selected?.id || "",
              selected?.provider || "",
            );
            this.showNew = false;
          });
        });
      this.bind("#cancel-new", () => {
        this.showNew = false;
      });
      return;
    }
    if (this.data.chatKey) {
      this.renderChat();
      return;
    }
    this.panel.innerHTML = `<div class="heading"><h1>Чаты</h1><button id="new">＋ Новый чат</button></div><form id="search-form" class="inline"><input id="session-search" aria-label="Поиск чатов" value="${esc(this.search)}" placeholder="Поиск чатов"><button>Найти</button></form><label class="check"><input type="checkbox" id="hidden" ${this.hidden ? "checked" : ""}> Показывать скрытые</label><div id="session-list" class="cards"></div>`;
    this.bind("#new", async () => {
      this.showNew = true;
      await this.data.catalog(this.creationProfile);
    });
    this.panel
      .querySelector("#search-form")!
      .addEventListener("submit", (event) => {
        event.preventDefault();
        this.search = (
          this.panel.querySelector("#session-search") as HTMLInputElement
        ).value;
        void this.run(() => this.data.list(this.search, this.hidden));
      });
    this.panel.querySelector("#hidden")!.addEventListener("change", (event) => {
      this.hidden = (event.target as HTMLInputElement).checked;
      void this.run(() => this.data.list(this.search, this.hidden));
    });
    const list = this.panel.querySelector("#session-list")!;
    const sessions = [...this.data.sessions].sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        (b.updatedAt || 0) - (a.updatedAt || 0),
    );
    for (const session of sessions) {
      const button = this.button(
        `${session.pinned ? "★ " : ""}${session.label || session.displayName || session.title || "Без названия"}\n${sessionStatus(session, this.relay.online)}\n${String((session as any).preview || "").slice(0, 160)}`,
        () => this.data.openChat(session.key),
        "card session-card",
      );
      list.append(button);
    }
    if (!sessions.length)
      list.innerHTML = `<p class="empty">${this.relay.online ? "Чатов пока нет. Создайте первый." : "Подключите Hermes в настройках."}</p>`;
  }
  private modelOptions(selected = "") {
    return this.data.models
      .map(
        (m) =>
          `<option value="${esc(`${m.provider}/${m.id}`)}" ${selected === `${m.provider}/${m.id}` ? "selected" : ""}>${esc(m.name || m.id)} · ${esc(m.provider)}</option>`,
      )
      .join("");
  }
  private renderChat() {
    const key = this.data.chatKey,
      session = this.data.sessions.find((x) => x.key === key),
      foreign = key.split(":")[2] === "x";
    const title =
      session?.label ||
      session?.displayName ||
      session?.title ||
      (key.includes(":x:cron:")
        ? "Запуск задачи"
        : foreign
          ? "Чат Hermes"
          : "Новый чат");
    this.panel.innerHTML = `<div class="heading"><button id="chat-back">‹ Чаты</button><h1>${esc(title)}</h1><button id="on-glasses">На очки</button></div><div class="row" id="chat-actions"></div><div class="messages" role="log" aria-label="Переписка">${this.data.hasMore ? '<button id="older">Предыдущие сообщения</button>' : ""}${this.data.messages.map((message, i) => `<article class="message ${message.role === "user" ? "user" : "assistant"}"><div class="message-meta">${esc(message.role === "user" ? "Вы" : message.role === "assistant" ? "Hermes" : message.role)}${this.showContext ? `<label><input type="checkbox" data-context="${i}" ${this.contextIds.has(String(message.id ?? i)) ? "checked" : ""}> В контекст задачи</label>` : ""}</div><div class="markdown">${markdown(messageText(message.content))}</div><button class="schedule-from" data-index="${i}">В расписание</button></article>`).join("")}${this.data.liveText ? `<article class="message assistant streaming"><div class="message-meta">Hermes · отвечает…</div><div class="markdown">${markdown(this.data.liveText)}</div></article>` : ""}</div><button id="latest">К новым сообщениям ↓</button>${foreign ? '<p class="muted">Это история отдельной сессии. Продолжение и остановка доступны там, где она запущена.</p>' : `<form id="compose-chat"><textarea id="message-input" aria-label="Сообщение Hermes" rows="3" placeholder="Сообщение Hermes…">${esc(this.data.draft())}</textarea><div id="attachment-list" class="row"></div><div class="row"><label class="file-button">Файл<input type="file" id="files" multiple></label><button type="button" id="gallery">Фото</button><button type="button" id="camera">Камера</button><button type="button" id="dictate">${this.recording ? "Завершить диктовку" : "Диктовать"}</button><button type="submit">Отправить</button></div></form>`}`;
    this.bind("#chat-back", async () => {
      await this.data.closeChat();
      await this.data.list(this.search, this.hidden);
    });
    this.bind("#on-glasses", () => this.hud.show({ kind: "chat", key, title }));
    this.bind("#older", () => this.data.older());
    this.bind("#latest", () => {
      const el = this.panel.querySelector(".messages")!;
      el.scrollTop = el.scrollHeight;
    });
    const actions = this.panel.querySelector("#chat-actions")!;
    if (key.includes(":x:cron:"))
      actions.append(
        this.button("Продолжить с результатом", async () => {
          const context = [...this.data.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          const ns = key.split(":")[1];
          await this.data.create(ns === "main" ? "default" : ns, "", "");
          this.data.saveDraft(
            `Результат предыдущего запуска:\n${messageText(context?.content).slice(0, 12000)}\n\nНовая задача: `,
          );
        }),
      );
    if (this.data.pendingSend())
      actions.append(
        this.button("Проверить отправку", async () => {
          const pending = this.data.pendingSend();
          const edited = pending?.text !== this.data.draft();
          const receipt = await this.data.checkSend();
          if (receipt?.status === "accepted" && pending?.hadFiles && !edited)
            this.files = [];
          this.message(
            receipt?.status === "not_found"
              ? "Hermes не получил операцию. Можно повторить исходное сообщение."
              : receipt?.error
                ? errorText(receipt.error)
                : `Отправка: ${receipt ? statusText(receipt.status) : "нет данных"}`,
          );
        }),
      );
    actions.append(
      this.button("Вопросы сессии", () => {
        this.tab = "inbox";
        this.inboxTab = "pending";
        this.render();
      }),
    );
    if (session?.actions?.pin)
      actions.append(
        this.button(session.pinned ? "Открепить" : "Закрепить", async () => {
          await this.data.request("sessions.pin", {
            key,
            pinned: !session.pinned,
          });
          await this.data.list(this.search, this.hidden);
        }),
      );
    if (session?.actions?.rename)
      actions.append(
        this.button("Переименовать", () => {
          this.renameSession = { key, title };
        }),
      );
    if (session?.actions?.hide)
      actions.append(
        this.button(session.hidden ? "Вернуть в список" : "Скрыть", () => {
          this.confirm(
            session.hidden
              ? "Вернуть чат в список?"
              : "Скрыть чат? Его активные вопросы останутся во Входящих.",
            async () => {
              await this.data.request("sessions.patch", {
                key,
                hidden: !session.hidden,
              });
              await this.data.closeChat();
              await this.data.list(this.search, this.hidden);
            },
          );
        }),
      );
    if (session?.actions?.stop)
      actions.append(
        this.button("Остановить", () => {
          this.confirm("Остановить текущую работу Hermes?", async () => {
            await this.data.request("sessions.abort", { key });
            this.message("Остановка запрошена");
          });
        }),
      );
    actions.append(
      this.button(
        this.showContext ? "Готово: создать задачу" : "Выбрать контекст задачи",
        () => {
          if (this.showContext) {
            const selected = this.data.messages.filter((m, i) =>
              this.contextIds.has(String(m.id ?? i)),
            );
            return this.newSchedule(
              selected
                .map((m) => `${m.role}: ${messageText(m.content)}`)
                .join("\n\n"),
            );
          } else this.showContext = true;
        },
      ),
    );
    this.panel.querySelectorAll<HTMLInputElement>("[data-context]").forEach(
      (input) =>
        (input.onchange = () => {
          const i = Number(input.dataset.context),
            id = String(this.data.messages[i].id ?? i);
          input.checked ? this.contextIds.add(id) : this.contextIds.delete(id);
        }),
    );
    this.panel.querySelectorAll<HTMLButtonElement>(".schedule-from").forEach(
      (button) =>
        (button.onclick = () => {
          const m = this.data.messages[Number(button.dataset.index)];
          void this.run(() =>
            this.newSchedule(`${m.role}: ${messageText(m.content)}`),
          );
        }),
    );
    if (foreign) return;
    this.composer = this.panel.querySelector("#message-input")!;
    this.composer.oninput = () => this.data.saveDraft(this.composer!.value);
    this.panel
      .querySelector("#compose-chat")!
      .addEventListener("submit", (event) => {
        event.preventDefault();
        const text = this.composer!.value,
          attachments = this.files,
          files = [...attachments];
        void this.run(async () => {
          if (this.recording) throw Error("Завершите диктовку");
          await this.data.send(text, files);
          for (const file of files) {
            const index = attachments.indexOf(file);
            if (index !== -1) attachments.splice(index, 1);
          }
        });
      });
    const attachments = this.panel.querySelector("#attachment-list")!;
    for (const [index, file] of this.files.entries()) {
      const chip = document.createElement("div");
      chip.className = "attachment";
      if (file.type.startsWith("image/")) {
        const img = document.createElement("img"),
          url = URL.createObjectURL(file);
        img.src = url;
        img.alt = file.name;
        img.onload = () => URL.revokeObjectURL(url);
        chip.append(img);
      }
      chip.append(
        this.button(`${file.name} ×`, () => {
          this.files.splice(index, 1);
        }),
      );
      attachments.append(chip);
    }
    this.panel.querySelector<HTMLInputElement>("#files")!.onchange = (
      event,
    ) => {
      this.files.push(
        ...Array.from((event.target as HTMLInputElement).files || []),
      );
      this.render();
    };
    this.bind("#gallery", () => this.nativeImage(false));
    this.bind("#camera", () => this.nativeImage(true));
    this.bind("#dictate", () =>
      this.recording ? this.stopRecording() : this.startRecording("chat"),
    );
  }
  private renderRename() {
    const target = this.renameSession!;
    this.panel.innerHTML = `<h1>Переименовать чат</h1><form id="rename-form"><label>Название<textarea id="rename-text" rows="2" maxlength="160" required>${esc(target.title)}</textarea></label><button>Сохранить</button><button type="button" id="rename-cancel">Отмена</button></form>`;
    this.panel.querySelector<HTMLTextAreaElement>("#rename-text")!.oninput = (
      event,
    ) => (target.title = (event.target as HTMLTextAreaElement).value);
    this.panel.querySelector<HTMLFormElement>("#rename-form")!.onsubmit = (
      event,
    ) => {
      event.preventDefault();
      void this.run(async () => {
        await this.data.request("sessions.patch", {
          key: target.key,
          label: target.title.trim(),
        });
        this.renameSession = null;
        await this.data.list(this.search, this.hidden);
      });
    };
    this.bind("#rename-cancel", () => {
      this.renameSession = null;
    });
  }
  private async nativeImage(camera: boolean) {
    if (!this.glasses.bridge) {
      (this.panel.querySelector("#files") as HTMLInputElement).click();
      return;
    }
    const asset = await (camera
      ? this.glasses.bridge.captureImageFromCamera()
      : this.glasses.bridge.pickImageFromAlbum());
    if (!asset) return;
    if (asset.size > this.relay.capabilities.uploads?.fileBytes)
      throw Error("Изображение превышает лимит сервера");
    const raw = asset as any;
    const content = raw.base64 ?? raw.data ?? raw.imageData;
    if (typeof content !== "string")
      throw Error("Even Hub не вернул данные изображения");
    const binary = atob(content.replace(/^data:[^;]+;base64,/, "")),
      bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    this.files.push(
      new File([bytes], raw.name || raw.fileName || "image.jpg", {
        type: raw.mimeType || "image/jpeg",
      }),
    );
  }
  private renderInbox() {
    if (this.question) {
      this.renderQuestion();
      return;
    }
    this.panel.innerHTML = `<h1>Входящие</h1><div class="row"><button id="pending">Нужен ответ · ${this.inbox.snapshot.pending.length}</button><button id="completed">Результаты · ${this.inbox.snapshot.unreadCompleted ?? this.inbox.snapshot.completed.filter((x) => !x.read).length}</button></div><div class="cards" id="inbox-list"></div>`;
    this.bind("#pending", () => {
      this.inboxTab = "pending";
    });
    this.bind("#completed", () => {
      this.inboxTab = "completed";
    });
    const list = this.panel.querySelector("#inbox-list")!;
    if (this.inboxTab === "pending")
      for (const item of this.inbox.snapshot.pending)
        list.append(
          this.button(
            `${item.agentName} / ${item.sessionTitle}\n${item.question}\n${item.kind === "permission" ? "Разрешение" : "Вопрос"}`,
            () => {
              this.question = item;
              this.selected.clear();
              this.answerDraft = "";
            },
            "card",
          ),
        );
    else
      for (const item of this.inbox.snapshot.completed) {
        const card = document.createElement("article");
        card.className = "card";
        card.innerHTML = `<h2>${item.read ? "" : "● "}${esc(item.sessionTitle)}</h2><p class="muted">${esc(item.agentName)} · ${esc(new Date(item.createdAtMs).toLocaleString("ru-RU"))}</p><div class="markdown">${markdown(item.summary)}</div>`;
        card.append(
          this.button(
            item.sessionKey.includes(":cron-run:")
              ? "Открыть историю задачи"
              : "Открыть чат",
            async () => {
              if (item.sessionKey.includes(":cron-run:") && item.jobId) {
                await this.data.loadJobs(item.profileId || "default");
                const result = await this.data.schedule("jobs.history", {
                  jobId: item.jobId,
                });
                this.data.history = result.history || [];
                this.data.historyCursor = result.nextBefore || null;
                this.historyJob = item.jobId;
                this.tab = "schedule";
                return;
              }
              await this.data.openChat(item.sessionKey);
              this.tab = "chats";
            },
          ),
          this.button("На очки", () =>
            this.hud.show({
              kind: "result",
              key: item.sessionKey,
              id: item.id,
            }),
          ),
          this.button("Отметить прочитанным", async () => {
            await this.data.request("inbox.read", { id: item.id });
            await this.refreshInbox();
          }),
        );
        list.append(card);
      }
    if (!list.childElementCount)
      list.innerHTML = '<p class="empty">Здесь пока ничего нет.</p>';
    if (
      this.inboxTab === "completed" &&
      this.inbox.snapshot.completedNextBefore
    )
      list.append(
        this.button("Предыдущие результаты", async () => {
          const page = await this.data.request("inbox.completed", {
            before: this.inbox.snapshot.completedNextBefore,
          });
          this.inbox.update({
            ...this.inbox.snapshot,
            completed: page.items,
            completedNextBefore: page.nextBefore,
          });
        }),
      );
  }
  private renderQuestion() {
    const item = this.inbox.snapshot.pending.find(
      (x) => x.id === this.question?.id,
    );
    if (!item) {
      this.question = null;
      this.message("Запрос закрыт или больше недоступен");
      this.renderInbox();
      return;
    }
    this.question = item;
    this.panel.innerHTML = `<button id="question-back">‹ Входящие</button><h1>${esc(item.sessionTitle)}</h1><p class="muted">${esc(item.agentName)} · ${item.kind === "permission" ? "Разрешение" : "Вопрос"}</p><div class="markdown">${markdown(item.question)}</div><div id="answer-options" class="cards"></div><form id="answer-form"><textarea id="answer-text" aria-label="Ответ агенту" rows="4">${esc(this.answerDraft)}</textarea><div class="row"><button type="button" id="answer-voice">${this.recording ? "Завершить диктовку" : "Надиктовать"}</button><button>Проверить ответ</button></div></form><div class="row" id="question-links"></div>`;
    this.bind("#question-back", () => {
      this.question = null;
    });
    const options = this.panel.querySelector("#answer-options")!;
    const prepare = (answer: Answer, label: string) =>
      this.confirm(
        `${item.agentName} / ${item.sessionTitle}\n\nОтправить ответ:\n${label}`,
        async () => {
          const result = await this.data.answer(item, answer);
          if (result.status !== "accepted")
            throw Error(
              result.error
                ? errorText(result.error)
                : statusText(result.status),
            );
          this.question = null;
          this.answerDraft = "";
          await this.refreshInbox().catch(() => {});
          this.message("Ответ принят");
        },
      );
    if (item.kind === "permission")
      for (const decision of item.allowedDecisions || [])
        options.append(
          this.button(
            (
              {
                deny: "Запретить",
                allow: "Разрешить",
                once: "Разрешить один раз",
                "allow-once": "Разрешить один раз",
                session: "Разрешить для сессии",
                "allow-session": "Разрешить для сессии",
              } as Record<string, string>
            )[decision] || decision,
            () => prepare({ decision }, decision),
          ),
        );
    else
      for (const [index, choice] of (item.choices || []).entries())
        options.append(
          this.button(
            `${item.multiSelect ? (this.selected.has(index) ? "☑ " : "☐ ") : ""}${choice}`,
            () => {
              if (item.multiSelect) {
                this.selected.has(index)
                  ? this.selected.delete(index)
                  : this.selected.add(index);
              } else prepare({ indices: [index] }, choice);
            },
          ),
        );
    if (item.multiSelect)
      options.append(
        this.button("Продолжить с выбранными", () => {
          if (!this.selected.size) throw Error("Выберите варианты");
          const indices = [...this.selected].sort((a, b) => a - b);
          prepare({ indices }, indices.map((i) => item.choices![i]).join("; "));
        }),
      );
    (this.panel.querySelector("#answer-text") as HTMLTextAreaElement).oninput =
      (event) => {
        this.answerDraft = (event.target as HTMLTextAreaElement).value;
      };
    (this.panel.querySelector("#answer-form") as HTMLFormElement).hidden =
      item.kind === "permission" || item.allowOther === false;
    this.panel
      .querySelector("#answer-form")!
      .addEventListener("submit", (event) => {
        event.preventDefault();
        if (this.answerDraft.trim())
          prepare({ text: this.answerDraft.trim() }, this.answerDraft.trim());
      });
    this.bind("#answer-voice", () =>
      this.recording ? this.stopRecording() : this.startRecording("answer"),
    );
    this.panel.querySelector("#question-links")!.append(
      this.button("На очки", () =>
        this.hud.show({ kind: "question", key: item.sessionKey, id: item.id }),
      ),
      this.button("Открыть чат", async () => {
        await this.data.openChat(item.sessionKey);
        this.tab = "chats";
      }),
    );
  }
  private async newSchedule(context = "") {
    this.tab = "schedule";
    this.job = null;
    this.editorState = null;
    this.preview = null;
    this.historyJob = "";
    const ns = this.data.chatKey.split(":")[1];
    this.fields = {
      name: "",
      prompt: context
        ? `Задача:\n\n\nКонтекст, выбранный пользователем:\n${context}`
        : "",
      schedule: "0 9 * * *",
    };
    await this.data.loadJobs(ns ? (ns === "main" ? "default" : ns) : undefined);
    this.render();
  }
  private renderSchedule() {
    if (this.fields) {
      this.renderScheduleEditor();
      return;
    }
    if (this.historyJob) {
      this.renderHistory();
      return;
    }
    this.panel.innerHTML = `<div class="heading"><h1>Расписание</h1><button id="new-job">＋ Задача</button></div><label>Агент<select id="job-profile">${this.data.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === this.data.profile ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><p class="muted">${esc(this.data.options ? `Время Hermes: ${this.data.options.serverLocalTime || new Date(this.data.options.serverNowMs).toISOString()} · пояс ${this.data.options.timezone}` : "Время и расписание определяет Hermes")}</p><p class="muted">${esc(this.data.options?.missedPolicy || "")}</p><div id="job-filters" class="row"></div><div id="job-list" class="cards"></div><button id="check-operation">Проверить неподтверждённую операцию</button>`;
    this.bind("#new-job", () => this.newSchedule());
    this.panel.querySelector<HTMLSelectElement>("#job-profile")!.onchange = (
      event,
    ) =>
      void this.run(() =>
        this.data.loadJobs((event.target as HTMLSelectElement).value),
      );
    this.bind("#check-operation", async () => {
      const result = await this.data.reconcileSchedule();
      if (result?.status === "not_found")
        this.confirm(
          "Hermes не получил предыдущую операцию. Повторить её с прежним идентификатором?",
          async () => {
            await this.data.retrySchedule();
            await this.data.loadJobs();
          },
        );
      else
        this.message(
          result
            ? result.error
              ? errorText(result.error)
              : `Состояние операции: ${statusText(result.status)}`
            : "Неподтверждённых операций нет",
        );
      await this.data.loadJobs();
    });
    for (const [id, label] of [
      ["all", "Все"],
      ["active", "Активные"],
      ["paused", "На паузе"],
      ["error", "Ошибки"],
    ])
      this.panel.querySelector("#job-filters")!.append(
        this.button(
          label,
          () => {
            this.jobFilter = id;
          },
          this.jobFilter === id ? "active" : "",
        ),
      );
    const list = this.panel.querySelector("#job-list")!;
    for (const job of this.data.jobs.filter(
      (j) =>
        this.jobFilter === "all" ||
        (this.jobFilter === "paused" && j.paused) ||
        (this.jobFilter === "error" &&
          (["error", "failed", "blocked_config"].includes(j.state) ||
            ["failed", "unknown"].includes(j.lastExecution?.status || "") ||
            j.lastStatus === "blocked_config")) ||
        (this.jobFilter === "active" &&
          !j.paused &&
          !["completed", "error"].includes(j.state)),
    )) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `<h2>${esc(job.name)}</h2><p>${esc(job.schedule)}</p><p>Следующий запуск: ${esc(date(job.nextRunAt))}</p><p class="muted">${esc(job.paused ? "На паузе" : statusText(job.state))} · последний: ${esc(job.lastExecution ? (job.lastExecution.stopRequested ? "Остановка запрошена" : job.lastExecution.needsAnswer ? "Нужен ответ" : statusText(job.lastExecution.status)) : "ещё не запускалась")}</p><div class="row"></div>`;
      const actions = card.querySelector(".row")!;
      actions.append(
        this.button("Изменить", async () => {
          const result = await this.data.schedule("automations.read", {
            jobId: job.id,
          });
          this.job = result.job;
          this.editorState = null;
          this.fields = { ...result.job.fields };
          this.preview = null;
        }),
        this.button(job.paused ? "Возобновить" : "Пауза", () =>
          this.confirm(
            `${job.paused ? "Возобновить" : "Приостановить"} расписание «${job.name}»? Текущее выполнение не останавливается.`,
            async () => {
              await this.data.mutateSchedule(
                job.paused ? "jobs.resume" : "jobs.pause",
                { jobId: job.id },
              );
              await this.data.loadJobs();
            },
          ),
        ),
        this.button("Запустить сейчас", () =>
          this.confirm(
            `Запустить «${job.name}» сейчас?\n${this.data.options?.runNowPolicy || "Штатное поведение Hermes"}`,
            async () => {
              await this.data.mutateSchedule("jobs.run", { jobId: job.id });
              await this.data.loadJobs();
            },
          ),
        ),
        this.button("История", async () => {
          const result = await this.data.schedule("jobs.history", {
            jobId: job.id,
          });
          this.data.history = result.history || [];
          this.data.historyCursor = result.nextBefore || null;
          this.historyJob = job.id;
        }),
        this.button("Удалить", async () => {
          const result = await this.data.schedule("automations.read", {
            jobId: job.id,
          });
          this.confirm(
            `Удалить расписание «${job.name}»? История выполнений останется в Hermes.`,
            async () => {
              await this.data.mutateSchedule("automations.delete", {
                jobId: job.id,
                revision: result.job.revision,
              });
              await this.data.loadJobs();
            },
          );
        }),
      );
      if (
        this.data.options?.stopSupported &&
        ["running", "claimed"].includes(job.lastExecution?.status || "")
      )
        actions.append(
          this.button("Остановить выполнение", () =>
            this.confirm(
              "Остановить этот запуск? Расписание продолжит действовать.",
              async () => {
                await this.data.mutateSchedule("jobs.stop", {
                  jobId: job.id,
                  executionId: job.lastExecution?.id,
                });
                this.message("Остановка запрошена");
              },
            ),
          ),
        );
      list.append(card);
    }
    if (!this.data.jobs.length)
      list.innerHTML = `<p class="empty">${esc(this.data.options?.supported === false ? this.data.options.reason : "Создайте первую задачу. Выполнение продолжится на VPS после закрытия приложения.")}</p>`;
  }
  private renderScheduleEditor() {
    const fields = this.fields!;
    const state = this.editorState ?? scheduleForm(fields.schedule);
    const original = this.job?.fields as ScheduleFields | undefined;
    const modelValue = (fields: Pick<ScheduleFields, "model" | "provider">) =>
      fields.model || fields.provider
        ? `${fields.provider || ""}/${fields.model || ""}`
        : "";
    const savedModel = original ? modelValue(original) : "";
    const availableModel = (value: string) =>
      this.data.models.find((m) => `${m.provider}/${m.id}` === value);
    const modelFields = (value: string) => {
      const model = availableModel(value);
      if (model) return { model: model.id, provider: model.provider };
      if (original && savedModel && value === savedModel)
        return { model: original.model, provider: original.provider };
      return savedModel
        ? { model: "", provider: "" }
        : { model: undefined, provider: undefined };
    };
    this.editorState = state;
    this.panel.innerHTML = `<button id="schedule-back">‹ Расписание</button><h1>${this.job ? "Изменить задачу" : "Новая задача"}</h1><p class="muted">Пояс Hermes: ${esc(this.data.options?.timezone || "загружается")}</p><form id="schedule-form"><label>Название<input id="job-name" name="name" required maxlength="160" value="${esc(fields.name)}"></label><label>Инструкция и выбранный контекст<textarea id="job-prompt" name="prompt" required rows="7" maxlength="16000">${esc(fields.prompt)}</textarea></label><label>Повтор<select id="schedule-kind" name="kind"><option value="cron">Расширенное / существующее</option><option value="once">Один раз</option><option value="daily">Ежедневно</option><option value="weekly">По дням недели</option><option value="interval">Через интервал</option></select></label><div id="schedule-inputs"><label data-schedule-for="once">Дата<input name="date" type="date" value="${esc(state.date)}"></label><label data-schedule-for="once daily weekly">Время Hermes<input name="time" type="time" value="${esc(state.time)}"></label><fieldset data-schedule-for="weekly"><legend>Дни недели</legend>${[
      [1, "Пн"],
      [2, "Вт"],
      [3, "Ср"],
      [4, "Чт"],
      [5, "Пт"],
      [6, "Сб"],
      [0, "Вс"],
    ]
      .map(
        ([id, label]) =>
          `<label class="check"><input name="days" type="checkbox" value="${id}" ${state.days.includes(String(id)) ? "checked" : ""}>${label}</label>`,
      )
      .join(
        "",
      )}</fieldset><label data-schedule-for="interval">Интервал<input name="interval" value="${esc(state.interval)}" placeholder="30m, 2h, 1d"></label><label data-schedule-for="cron">Выражение Hermes<input id="job-expression" name="cron" value="${esc(state.cron)}"></label></div><label>Модель<select name="model"><option value="">Настройка Hermes</option>${this.modelOptions(modelValue(fields))}${savedModel && !availableModel(savedModel) ? `<option value="${esc(savedModel)}" ${savedModel === modelValue(fields) ? "selected" : ""}>${esc(original?.model || original?.provider)} · текущая настройка</option>` : ""}</select></label><button>Проверить расписание</button><button type="button" id="schedule-voice">${this.recording ? "Завершить диктовку" : "Задать голосом"}</button></form><div id="schedule-preview"></div>`;
    this.bind("#schedule-back", () => {
      this.fields = null;
      this.job = null;
      this.preview = null;
    });
    const form = this.panel.querySelector<HTMLFormElement>("#schedule-form")!;
    (form.elements.namedItem("kind") as HTMLSelectElement).value = state.kind;
    const updateVisibility = () => {
      const kind = (form.elements.namedItem("kind") as HTMLSelectElement).value;
      form
        .querySelectorAll<HTMLElement>("[data-schedule-for]")
        .forEach(
          (element) =>
            (element.hidden = !element.dataset
              .scheduleFor!.split(" ")
              .includes(kind)),
        );
    };
    updateVisibility();
    form.oninput = () => {
      const data = new FormData(form);
      this.editorState = readSchedule(data);
      updateVisibility();
      this.fields = {
        ...this.fields!,
        name: String(data.get("name")),
        prompt: String(data.get("prompt")),
        ...modelFields(String(data.get("model"))),
      };
      this.preview = null;
      this.panel.querySelector("#schedule-preview")?.replaceChildren();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(form);
      void this.run(async () => {
        const expression = serializeSchedule(
          readSchedule(data),
          original?.schedule,
        );
        this.fields = {
          name: String(data.get("name")),
          prompt: String(data.get("prompt")),
          schedule: expression,
          deliver: this.fields?.deliver || "local",
          ...modelFields(String(data.get("model"))),
        };
        this.preview = (
          await this.data.schedule("automations.preview", {
            fields: this.fields,
            ...(this.job
              ? { jobId: this.job.id, revision: this.job.revision }
              : {}),
          })
        ).preview;
      });
    };
    this.bind("#schedule-voice", () =>
      this.recording ? this.stopRecording() : this.startRecording("schedule"),
    );
    if (this.preview) {
      const box = this.panel.querySelector("#schedule-preview")!;
      box.innerHTML = `<section class="card"><h2>Проверьте задачу</h2><h3>${esc(this.fields!.name)}</h3><p class="preserve">${esc(this.fields!.prompt)}</p><p>${esc(this.preview.scheduleDisplay || this.fields!.schedule)} · ${esc(this.preview.timezone)}</p><h3>Ближайшие запуски по Hermes</h3><ol>${(this.preview.nextRuns || []).map((x: string) => `<li>${esc(date(x))}</li>`).join("")}</ol></section>`;
      box.append(
        this.button("Подтвердить и сохранить", async () => {
          await this.data.mutateSchedule(
            this.job ? "automations.update" : "automations.create",
            {
              fields: this.fields,
              reviewHash: this.preview.reviewHash,
              ...(this.job
                ? { jobId: this.job.id, revision: this.job.revision }
                : {}),
            },
          );
          this.fields = null;
          this.job = null;
          this.preview = null;
          await this.data.loadJobs();
        }),
      );
    }
  }
  private renderHistory() {
    this.panel.innerHTML =
      '<button id="history-back">‹ Расписание</button><h1>История запусков</h1><div id="execution-list" class="cards"></div>';
    this.bind("#history-back", () => {
      this.historyJob = "";
    });
    const list = this.panel.querySelector("#execution-list")!;
    for (const execution of this.data.history) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `<h2>${esc(execution.stopRequested && ["running", "claimed"].includes(execution.status) ? "Остановка запрошена" : execution.needsAnswer ? "Нужен ответ" : statusText(execution.status))}</h2><p>${esc(date(execution.startedAt))}</p><p>Доставка: ${esc(statusText(execution.delivery || "нет данных"))}</p><p>${esc(execution.reason || "")}</p><div class="markdown">${markdown(execution.summary || "")}</div>`;
      if (execution.sessionKey)
        card.append(
          this.button("Открыть запуск", async () => {
            await this.data.openChat(execution.sessionKey!);
            this.tab = "chats";
          }),
        );
      list.append(card);
    }
    if (this.data.historyCursor)
      list.append(
        this.button("Предыдущие запуски", async () => {
          const result = await this.data.schedule("jobs.history", {
            jobId: this.historyJob,
            before: this.data.historyCursor,
          });
          this.data.history.push(...result.history);
          this.data.historyCursor = result.nextBefore || null;
        }),
      );
    if (!this.data.history.length)
      list.innerHTML = '<p class="empty">Запусков пока нет.</p>';
  }
  private renderSettings() {
    this.panel.innerHTML = `<h1>Настройки</h1><section class="card"><h2>Подключение к Hermes</h2><form id="phone-connect"><label>Адрес сервера<input id="phone-url" name="url" type="url" required placeholder="wss://your-host.ts.net/" value="${esc(localStorage.getItem("ocuclaw.server") || "")}"></label><label>Ключ подключения<input id="phone-token" name="token" type="password" required autocomplete="off"></label><label class="check"><input name="remember" type="checkbox"> Сохранить подключение в Even Hub</label><button>Подключить</button></form><button id="forget">Забыть сохранённое подключение</button><p class="muted">Tailscale должен быть подключён на телефоне. По умолчанию ключ остаётся только в памяти приложения.</p></section><section class="card"><h2>Диктовка</h2><label>Микрофон<select id="microphone"><option value="phone">Телефон</option><option value="glasses" ${localStorage.getItem("ocuclaw.microphone") === "glasses" ? "selected" : ""}>Очки</option></select></label><p>Распознавание выполняет Hermes. Перед отправкой текст можно исправить.</p></section><section class="card"><h2>Состояние</h2><p>${this.relay.online ? "Hermes подключён" : "Нет связи с Hermes"}</p><p>${this.glasses.displayReady ? "G2 подключены" : "Очки отключены — работа на телефоне доступна"}</p><p>Агенты: ${esc(this.data.agents.map((a) => a.name).join(", ") || "нет данных")}</p><p>Часовой пояс Hermes: ${esc(this.data.options?.timezone || "откройте Расписание")}</p><button id="hud-toggle">${this.hudRoot.hidden ? "Открыть" : "Закрыть"} панель очков</button></section>`;
    this.panel
      .querySelector("#phone-connect")!
      .addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        void this.run(async () => {
          const address = String(data.get("url")),
            token = String(data.get("token"));
          this.connect(address, token);
          if (data.get("remember")) {
            if (
              !this.glasses.bridge ||
              !(await this.glasses.bridge.setLocalStorage(
                "ocuclaw.connection",
                JSON.stringify({ address, token }),
              ))
            )
              throw Error("Подключение работает, но Even Hub не сохранил ключ");
          } else if (this.glasses.bridge)
            await this.glasses.bridge.setLocalStorage("ocuclaw.connection", "");
        });
      });
    this.bind("#forget", async () => {
      await this.glasses.bridge?.setLocalStorage("ocuclaw.connection", "");
      this.message("Сохранённое подключение удалено");
    });
    this.panel.querySelector<HTMLSelectElement>("#microphone")!.onchange = (
      event,
    ) =>
      localStorage.setItem(
        "ocuclaw.microphone",
        (event.target as HTMLSelectElement).value,
      );
    this.bind("#hud-toggle", () => {
      this.hudRoot.hidden = !this.hudRoot.hidden;
    });
  }
  private async startRecording(target: "chat" | "answer" | "schedule") {
    if (!this.hud.canSwitch()) throw Error("Завершите действие на очках");
    this.dictationTarget = target;
    await this.glasses.start(
      localStorage.getItem("ocuclaw.microphone") === "glasses"
        ? AudioInputSource.Glasses
        : AudioInputSource.Phone,
      () => {
        void this.run(() => this.stopRecording());
      },
    );
    this.recording = true;
    this.recordTimer = setTimeout(
      () => void this.run(() => this.stopRecording()),
      17000,
    );
    this.message("Слушаю… Нажмите ещё раз для завершения.");
  }
  private async stopRecording(cancel = false) {
    clearTimeout(this.recordTimer);
    try {
      const pcm = await this.glasses.stop();
      if (cancel) return;
      const result = await this.data.request("workspace.stt.transcribe", {
        wav: wavBase64(pcm),
        language: "ru",
      });
      const text = String(result.text || result.transcript || "").trim();
      if (!text) throw Error("Речь не распознана. Повторите запись.");
      if (this.dictationTarget === "chat")
        this.data.saveDraft(
          [this.data.draft(), text].filter(Boolean).join("\n"),
        );
      else if (this.dictationTarget === "answer") this.answerDraft = text;
      else {
        const result = await this.data.schedule("automations.draft", { text });
        this.fields = result.fields;
        this.editorState = null;
        this.preview = null;
      }
      this.message("Текст распознан. Проверьте перед отправкой.");
    } finally {
      this.recording = false;
    }
  }
}

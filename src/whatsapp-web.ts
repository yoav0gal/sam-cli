import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type ChromeProfile = {
  key: string;
  label: string;
  email: string;
  dir: string;
};

type WhatsappOptions = {
  profile: ChromeProfile;
  out: string;
  chat?: string;
  chatIndex?: number;
  listChats: boolean;
  maxScrolls: number;
  headless: boolean;
  keepProfile: boolean;
};

type WhatsappLogOptions = {
  profile: ChromeProfile;
  out: string;
  logPath: string;
  chatLimit: number;
  messagesPerChat: number;
  maxScrolls: number;
  headless: boolean;
  keepProfile: boolean;
};

type WhatsappExport = {
  exported_at: string;
  profile: string;
  email: string;
  mode: "chat_list" | "messages";
  selected_chat: string | null;
  chats?: Array<{ index: number; title: string; preview: string }>;
  messages?: Array<{
    direction: "in" | "out" | "unknown";
    timestamp: string | null;
    sender: string | null;
    text: string;
  }>;
};

type WhatsappRunLog = {
  run_id: string;
  exported_at: string;
  profile: string;
  email: string;
  chat_limit: number;
  messages_per_chat: number;
  visible_chat_count: number;
  logged_chat_count: number;
  chats: Array<{
    index: number;
    title: string;
    preview: string;
    messages: NonNullable<WhatsappExport["messages"]>;
    error?: string;
  }>;
};

const CHROME_ROOT = join(homedir(), "Library/Application Support/Google/Chrome");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function exportWhatsappWeb(options: WhatsappOptions) {
  const tempProfileRoot = join(tmpdir(), `sam-cli-whatsapp-${options.profile.key}-${process.pid}-${Date.now()}`);
  let chrome: ChildProcessWithoutNullStreams | undefined;

  try {
    cloneChromeProfile(options.profile, tempProfileRoot);
    chrome = await launchChrome(tempProfileRoot, options.profile.dir, options.headless);
    const port = await waitForDevtoolsPort(tempProfileRoot);
    const cdp = await Cdp.connect(port);

    await cdp.navigate("https://web.whatsapp.com/");
    await cdp.waitForReady();
    await waitForWhatsapp(cdp);

    if (options.chat || options.chatIndex !== undefined) {
      await openVisibleChat(cdp, { chat: options.chat, chatIndex: options.chatIndex });
    }

    const exportData: WhatsappExport = {
      exported_at: new Date().toISOString(),
      profile: options.profile.label,
      email: options.profile.email,
      mode: options.listChats && !options.chat && options.chatIndex === undefined ? "chat_list" : "messages",
      selected_chat: options.chat ?? (options.chatIndex !== undefined ? `index:${options.chatIndex}` : null),
    };

    if (exportData.mode === "chat_list") {
      exportData.chats = await cdp.evaluate(`(${extractVisibleChats.toString()})()`) as WhatsappExport["chats"];
    } else {
      exportData.messages = await scrapeMessages(cdp, options.maxScrolls);
    }

    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(exportData, null, 2)}\n`);
    await cdp.close();
    return { out: options.out, exportData };
  } finally {
    if (chrome && !chrome.killed) chrome.kill();
    if (!options.keepProfile) rmSync(tempProfileRoot, { recursive: true, force: true });
  }
}

export async function logWhatsappWeb(options: WhatsappLogOptions) {
  const tempProfileRoot = join(tmpdir(), `sam-cli-whatsapp-log-${options.profile.key}-${process.pid}-${Date.now()}`);
  let chrome: ChildProcessWithoutNullStreams | undefined;

  try {
    cloneChromeProfile(options.profile, tempProfileRoot);
    chrome = await launchChrome(tempProfileRoot, options.profile.dir, options.headless);
    const port = await waitForDevtoolsPort(tempProfileRoot);
    const cdp = await Cdp.connect(port);

    await cdp.navigate("https://web.whatsapp.com/");
    await cdp.waitForReady();
    await waitForWhatsapp(cdp);
    await sleep(3000);

    const visibleChats = await cdp.evaluate(`(${extractVisibleChats.toString()})()`) as NonNullable<WhatsappExport["chats"]>;
    const selectedChats = visibleChats.slice(0, options.chatLimit);
    const run: WhatsappRunLog = {
      run_id: new Date().toISOString().replace(/[:.]/g, "-"),
      exported_at: new Date().toISOString(),
      profile: options.profile.label,
      email: options.profile.email,
      chat_limit: options.chatLimit,
      messages_per_chat: options.messagesPerChat,
      visible_chat_count: visibleChats.length,
      logged_chat_count: 0,
      chats: [],
    };

    for (const chat of selectedChats) {
      const entry: WhatsappRunLog["chats"][number] = {
        index: chat.index,
        title: chat.title,
        preview: chat.preview,
        messages: [],
      };

      try {
        await openVisibleChat(cdp, { chatIndex: chat.index, chat: chat.title });
        const messages = await scrapeMessages(cdp, options.maxScrolls);
        entry.messages = messages.slice(-options.messagesPerChat);
        run.logged_chat_count += 1;
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }

      run.chats.push(entry);
    }

    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(run, null, 2)}\n`);
    mkdirSync(dirname(options.logPath), { recursive: true });
    appendFileSync(options.logPath, `${JSON.stringify(run)}\n`);
    await cdp.close();
    return { out: options.out, logPath: options.logPath, run };
  } finally {
    if (chrome && !chrome.killed) chrome.kill();
    if (!options.keepProfile) rmSync(tempProfileRoot, { recursive: true, force: true });
  }
}

function cloneChromeProfile(profile: ChromeProfile, tempProfileRoot: string) {
  mkdirSync(tempProfileRoot, { recursive: true });
  const profileDirName = profile.dir.split("/").pop();
  if (!profileDirName) throw new Error(`Could not determine Chrome profile directory from ${profile.dir}`);

  const localState = join(CHROME_ROOT, "Local State");
  if (existsSync(localState)) cpSync(localState, join(tempProfileRoot, "Local State"));

  cpSync(profile.dir, join(tempProfileRoot, profileDirName), {
    recursive: true,
    filter(source) {
      const skipParts = [
        "/Cache/",
        "/Code Cache/",
        "/GPUCache/",
        "/GrShaderCache/",
        "/ShaderCache/",
        "/DawnCache/",
        "/Crashpad/",
        "/Media Cache/",
        "/OptimizationGuidePredictionModels/",
        "/Safe Browsing",
        "/Service Worker/CacheStorage/",
      ];
      return !skipParts.some((part) => source.includes(part));
    },
  });
}

async function launchChrome(tempProfileRoot: string, originalProfileDir: string, headless: boolean) {
  const profileDirName = originalProfileDir.split("/").pop();
  if (!profileDirName) throw new Error(`Could not determine Chrome profile directory from ${originalProfileDir}`);

  const args = [
    `--user-data-dir=${tempProfileRoot}`,
    `--profile-directory=${profileDirName}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "--lang=en-US",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");

  const chrome = spawn(CHROME_BIN, args, { stdio: "pipe" });
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", () => {});
  chrome.stdout.on("data", () => {});
  return chrome;
}

async function waitForDevtoolsPort(tempProfileRoot: string) {
  const activePortPath = join(tempProfileRoot, "DevToolsActivePort");
  for (let i = 0; i < 300; i += 1) {
    if (existsSync(activePortPath)) {
      const [port] = readFileSync(activePortPath, "utf8").split("\n");
      if (port) return Number(port);
    }
    await sleep(100);
  }
  throw new Error("Chrome did not expose a DevTools port in time");
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private constructor(private ws: WebSocket) {}

  static async connect(port: number) {
    const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((res) => res.json() as Promise<Array<{ type: string; webSocketDebuggerUrl: string }>>);
    const page = tabs.find((tab) => tab.type === "page");
    if (!page) throw new Error("Could not find a Chrome page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const cdp = new Cdp(ws);
    ws.addEventListener("message", (event) => cdp.onMessage(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("Failed to connect to Chrome DevTools")), { once: true });
    });
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return cdp;
  }

  async navigate(url: string) {
    await this.send("Page.navigate", { url });
  }

  async waitForReady() {
    for (let i = 0; i < 80; i += 1) {
      const ready = await this.evaluate(`document.readyState === "complete" || document.readyState === "interactive"`);
      if (ready) return;
      await sleep(250);
    }
  }

  async evaluate(expression: string) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? "Evaluation failed");
    }
    return response.result?.value;
  }

  async close() {
    this.ws.close();
  }

  async mouseClick(x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  private send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private onMessage(data: string) {
    const message = JSON.parse(data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
}

async function waitForWhatsapp(cdp: Cdp) {
  for (let i = 0; i < 90; i += 1) {
    const state = await cdp.evaluate(`(${whatsappState.toString()})()`) as { ready: boolean; blocker: string | null };
    if (state.ready) return;
    if (state.blocker) throw new Error(state.blocker);
    await sleep(1000);
  }
  throw new Error("WhatsApp Web did not finish loading in time");
}

function whatsappState() {
  const text = document.body.innerText || "";
  if (/Use WhatsApp on your computer|Link with phone number|Scan this QR code|Keep your phone connected/i.test(text)) {
    return { ready: false, blocker: "WhatsApp Web is not linked in this cloned profile; it is showing the link-device screen." };
  }
  const ready = Boolean(document.querySelector("span[title], div[role='listitem'], div[role='row'], .message-in, .message-out, [aria-label*='Chat']"));
  return { ready, blocker: null };
}

function extractVisibleChats() {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const containers = new Set<HTMLElement>();
  for (const item of Array.from(document.querySelectorAll("div[role='listitem'], div[role='row']")) as HTMLElement[]) {
    containers.add(item);
  }
  for (const title of Array.from(document.querySelectorAll("span[title]")) as HTMLElement[]) {
    const container = title.closest("div[role='listitem'], div[role='row'], div[tabindex]") as HTMLElement | null;
    if (container) containers.add(container);
  }

  return Array.from(containers)
    .map((item, index) => {
      const title = clean(item.querySelector("span[title]")?.getAttribute("title"));
      const lines = clean(item.innerText).split(/\s{2,}|\n/).map(clean).filter(Boolean);
      return {
        index,
        title: title || lines[0] || "",
        preview: lines.filter((line) => line !== title).slice(0, 8).join(" | "),
      };
    })
    .filter((chat) => chat.title && !/whatsapp|search|archived|communities|status|channels/i.test(chat.title));
}

function findVisibleChatRect(query: string) {
  const needle = query.toLowerCase();
  const titleMatch = (Array.from(document.querySelectorAll("span[title]")) as HTMLElement[])
    .find((span) => (span.getAttribute("title") ?? span.innerText).toLowerCase().includes(needle));
  if (titleMatch) {
    titleMatch.scrollIntoView({ block: "center" });
    const rect = titleMatch.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  const chats = Array.from(document.querySelectorAll("div[role='listitem'], div[role='row']")) as HTMLElement[];
  const match = chats.find((chat) => {
    const title = chat.getAttribute("title") ?? "";
    return `${title}\n${chat.innerText}`.toLowerCase().includes(needle);
  });
  if (!match) return null;
  match.scrollIntoView({ block: "center" });
  const rect = match.getBoundingClientRect();
  return { x: rect.left + Math.min(rect.width / 2, 180), y: rect.top + rect.height / 2 };
}

function findVisibleChatRectByIndex(index: number) {
  const rows = Array.from(document.querySelectorAll("div[role='listitem'], div[role='row']")) as HTMLElement[];
  const row = rows[index];
  if (!row) return null;
  row.scrollIntoView({ block: "center" });
  const rect = row.getBoundingClientRect();
  return { x: rect.left + Math.min(rect.width / 2, 180), y: rect.top + rect.height / 2 };
}

async function openVisibleChat(cdp: Cdp, options: { chat?: string; chatIndex?: number }) {
  await sleep(3000);
  let opened = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rect = options.chat
      ? await cdp.evaluate(`(${findVisibleChatRect.toString()})(${JSON.stringify(options.chat)})`) as { x: number; y: number } | null
      : await cdp.evaluate(`(${findVisibleChatRectByIndex.toString()})(${options.chatIndex})`) as { x: number; y: number } | null;
    if (!rect) {
      const chats = await cdp.evaluate(`(${extractVisibleChats.toString()})()`) as WhatsappExport["chats"];
      throw new Error(`Could not find the requested visible chat. Run --list-chats first, or open/search that chat in WhatsApp Web and retry. Visible chats: ${chats?.map((chat) => `${chat.index}:${chat.title}`).filter(Boolean).slice(0, 8).join(", ")}`);
    }
    await cdp.mouseClick(rect.x, rect.y);
    await sleep(5000);
    opened = await cdp.evaluate("Boolean(document.querySelector('[data-pre-plain-text], .message-in, .message-out, [class*=copyable-text], div[data-id]'))") as boolean;
    if (opened) return;
  }
  if (!opened) await sleep(5000);
}

async function scrapeMessages(cdp: Cdp, maxScrolls: number) {
  const messages: WhatsappExport["messages"] = [];
  for (let i = 0; i < 20; i += 1) {
    const hasMessages = await cdp.evaluate("Boolean(document.querySelector('[data-pre-plain-text], .message-in, .message-out, [class*=copyable-text], div[data-id]'))") as boolean;
    if (hasMessages) break;
    await sleep(1000);
  }
  for (let i = 0; i < maxScrolls; i += 1) {
    const batch = await cdp.evaluate(`(${extractMessages.toString()})()`) as WhatsappExport["messages"];
    messages.push(...batch);
    const moved = await cdp.evaluate(`(${scrollMessagesUp.toString()})()`) as boolean;
    if (!moved) break;
    await sleep(1500);
  }
  const deduped = dedupeMessages(messages.reverse());
  if (deduped.length === 0) {
    const diagnostic = await cdp.evaluate(`({
      text: document.body.innerText.slice(0, 800),
      dataPre: document.querySelectorAll("[data-pre-plain-text]").length,
      copyable: document.querySelectorAll("[class*=copyable-text]").length,
      dataId: document.querySelectorAll("div[data-id]").length,
      messageIn: document.querySelectorAll(".message-in").length,
      messageOut: document.querySelectorAll(".message-out").length,
      activeTitle: document.querySelector("header span[title]")?.getAttribute("title") ?? null
    })`) as { text: string; dataPre: number; messageIn: number; messageOut: number; activeTitle: string | null };
    throw new Error(`No WhatsApp messages were visible after opening the chat. activeTitle=${diagnostic.activeTitle ?? "none"} dataPre=${diagnostic.dataPre} copyable=${(diagnostic as any).copyable} dataId=${(diagnostic as any).dataId} messageIn=${diagnostic.messageIn} messageOut=${diagnostic.messageOut} text=${JSON.stringify(diagnostic.text.slice(0, 240))}`);
  }
  return deduped;
}

function extractMessages() {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const containers = new Set<HTMLElement>();
  for (const bubble of Array.from(document.querySelectorAll(".message-in, .message-out")) as HTMLElement[]) {
    containers.add(bubble);
  }
  for (const copyable of Array.from(document.querySelectorAll("[data-pre-plain-text], [class*=copyable-text], div[data-id]")) as HTMLElement[]) {
    containers.add((copyable.closest(".message-in, .message-out, div[data-id]") as HTMLElement | null) ?? copyable);
  }

  return Array.from(containers).map((bubble) => {
    const element = bubble as HTMLElement;
    const dataId = element.getAttribute("data-id") ?? "";
    const direction = element.classList.contains("message-in")
      ? "in"
      : element.classList.contains("message-out") || dataId.startsWith("true_")
        ? "out"
        : dataId.startsWith("false_")
          ? "in"
          : "unknown";
    const copyable = element.querySelector("[data-pre-plain-text], [class*=copyable-text]") ?? (element.matches("[data-pre-plain-text], [class*=copyable-text]") ? element : null);
    const meta = copyable?.getAttribute("data-pre-plain-text") ?? null;
    const metaMatch = meta?.match(/^\[(.*?)\]\s*(.*?):\s*$/);
    const rawText = clean((copyable as HTMLElement | null)?.innerText || element.innerText);
    const text = rawText.replace(/\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*$/i, "").trim();
    return {
      direction,
      timestamp: metaMatch?.[1] ?? null,
      sender: metaMatch?.[2] ?? null,
      text,
    };
  }).filter((message) => message.text && !/^(online|typing\.\.\.|last seen\b)$/i.test(message.text));
}

function scrollMessagesUp() {
  const message = document.querySelector("[data-pre-plain-text], [class*=copyable-text], div[data-id], .message-in, .message-out");
  let node = message?.parentElement as HTMLElement | null;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 100) {
      const before = node.scrollTop;
      node.scrollTop = Math.max(0, before - Math.max(node.clientHeight, 700));
      return node.scrollTop !== before;
    }
    node = node.parentElement;
  }
  return false;
}

function dedupeMessages(messages: NonNullable<WhatsappExport["messages"]>) {
  const byKey = new Map<string, NonNullable<WhatsappExport["messages"]>[number]>();
  for (const message of messages) {
    const key = `${message.direction}\n${message.timestamp ?? ""}\n${message.sender ?? ""}\n${message.text}`;
    if (!byKey.has(key)) byKey.set(key, message);
  }
  return [...byKey.values()];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

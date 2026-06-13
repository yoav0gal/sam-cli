import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type ChromeProfile = {
  key: string;
  label: string;
  email: string;
  dir: string;
};

type PageService = "youtube" | "music" | "both";

type PageHistoryOptions = {
  profile: ChromeProfile;
  service: PageService;
  out: string;
  maxScrolls: number;
  headless: boolean;
  keepProfile: boolean;
};

type PageHistoryRow = {
  source: "youtube_history_page" | "youtube_music_history_page";
  profile: string;
  email: string;
  service: "youtube" | "youtube_music";
  date_group: string | null;
  page_type: string;
  title: string;
  detail: string;
  url: string;
  video_id: string | null;
  playlist_id: string | null;
};

const CHROME_ROOT = join(homedir(), "Library/Application Support/Google/Chrome");
const CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function exportPageHistory(options: PageHistoryOptions) {
  const tempProfileRoot = join(tmpdir(), `sam-cli-chrome-${options.profile.key}-${process.pid}-${Date.now()}`);
  let chrome: ChildProcessWithoutNullStreams | undefined;

  try {
    cloneChromeProfile(options.profile, tempProfileRoot);
    chrome = await launchChrome(tempProfileRoot, options.profile.dir, options.headless);
    const port = await waitForDevtoolsPort(tempProfileRoot);
    const cdp = await Cdp.connect(port);

    const rows: PageHistoryRow[] = [];
    const services = options.service === "both" ? ["youtube", "music"] as const : [options.service] as const;

    for (const service of services) {
      const url = service === "youtube"
        ? "https://www.youtube.com/feed/history"
        : "https://music.youtube.com/history";
      await cdp.navigate(url);
      await cdp.waitForReady();
      await sleep(3000);
      const pageRows = await scrapeHistoryPage(cdp, service, options.maxScrolls);
      rows.push(...pageRows.map((row) => ({
        ...row,
        profile: options.profile.label,
        email: options.profile.email,
      })));
    }

    const deduped = dedupeRows(rows);
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(deduped, null, 2)}\n`);
    await cdp.close();
    return { out: options.out, rows: deduped };
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
    "--disable-background-networking",
    "--disable-sync",
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
  for (let i = 0; i < 100; i += 1) {
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

async function scrapeHistoryPage(cdp: Cdp, service: "youtube" | "music", maxScrolls: number) {
  const rows: Omit<PageHistoryRow, "profile" | "email">[] = [];
  for (let i = 0; i < maxScrolls; i += 1) {
    const batch = await cdp.evaluate(`(${extractRows.toString()})(${JSON.stringify(service)})`) as Omit<PageHistoryRow, "profile" | "email">[];
    rows.push(...batch);
    const before = await cdp.evaluate("window.scrollY");
    await cdp.evaluate("window.scrollBy(0, Math.max(document.documentElement.clientHeight, 900))");
      await sleep(2000);
    const after = await cdp.evaluate("window.scrollY");
    if (after === before) break;
  }

  const bodyText = await cdp.evaluate("document.body.innerText.slice(0, 1200)") as string;
  if (rows.length === 0 && /sign in|choose an account|not available/i.test(bodyText)) {
    throw new Error(`The ${service} history page did not expose rows; visible page text suggests a login/account blocker.`);
  }

  return dedupeRows(rows);
}

function extractRows(service: "youtube" | "music") {
  const source = service === "music" ? "youtube_music_history_page" : "youtube_history_page";
  const result: Array<Omit<PageHistoryRow, "profile" | "email">> = [];

  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visibleText = (el: Element | null) => clean((el as HTMLElement | null)?.innerText || el?.textContent);
  const absolute = (href: string) => new URL(href, location.href).toString();
  const videoIdFromUrl = (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] ?? null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parsed.searchParams.get("v") ?? (parts[0] === "shorts" || parts[0] === "live" ? parts[1] ?? null : null);
  };
  const pageTypeFromUrl = (url: string) => {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" && parts[1]) return "shorts";
    if (videoIdFromUrl(url)) return "watch";
    if (parsed.searchParams.get("list")) return "playlist";
    if (parsed.pathname.startsWith("/channel/") || parsed.pathname.startsWith("/@")) return "channel";
    if (parsed.pathname === "/" || parsed.pathname === "") return "home";
    return "other";
  };
  const dateGroupFor = (el: Element) => {
    const top = (el as HTMLElement).getBoundingClientRect().top;
    let best: { top: number; text: string } | null = null;
    for (const heading of Array.from(document.querySelectorAll("h1,h2,h3,yt-formatted-string"))) {
      const text = visibleText(heading);
      if (!text || text.length > 80) continue;
      if (!/^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|היום|אתמול)$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(text)) continue;
      const headingTop = (heading as HTMLElement).getBoundingClientRect().top;
      if (headingTop <= top && (!best || headingTop > best.top)) best = { top: headingTop, text };
    }
    return best?.text ?? null;
  };

  const selector = service === "music"
    ? "ytmusic-responsive-list-item-renderer, ytmusic-two-row-item-renderer"
    : "ytd-video-renderer, ytd-reel-item-renderer, ytd-rich-item-renderer, ytd-playlist-renderer";

  const seenUrls = new Set<string>();
  const items = Array.from(document.querySelectorAll(selector));
  const itemLinks = items.flatMap((item) => {
    const link = Array.from(item.querySelectorAll("a[href]")).find((anchor) => {
      const href = (anchor as HTMLAnchorElement).href;
      return /youtube\.com|youtu\.be/.test(href) && /(watch\?v=|\/shorts\/|playlist\?list=|\/channel\/|\/@)/.test(href);
    }) as HTMLAnchorElement | undefined;
    return link ? [{ item, link }] : [];
  });

  const genericLinks = Array.from(document.querySelectorAll("a[href]")).flatMap((link) => {
    const href = (link as HTMLAnchorElement).href;
    if (!/youtube\.com|youtu\.be/.test(href) || !/(watch\?v=|\/shorts\/|playlist\?list=|\/channel\/|\/@)/.test(href)) return [];
    const item = link.closest(selector) ?? link.closest("ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytmusic-shelf-renderer, ytmusic-carousel-shelf-renderer") ?? link.parentElement ?? link;
    return [{ item, link: link as HTMLAnchorElement }];
  });

  for (const { item, link } of [...itemLinks, ...genericLinks]) {

    const url = absolute(link.getAttribute("href") ?? link.href);
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    const pageType = pageTypeFromUrl(url);
    if (pageType === "other") continue;
    const titleElement = item.querySelector("#video-title, .title, yt-formatted-string.title, a[title]");
    const title = clean((titleElement as HTMLElement | null)?.getAttribute?.("title")) || visibleText(titleElement) || clean(link.getAttribute("title")) || clean(link.getAttribute("aria-label")) || visibleText(link);
    const detail = visibleText(item);
    if (!title && !detail) continue;

    const parsed = new URL(url);
    result.push({
      source,
      service: service === "music" ? "youtube_music" : "youtube",
      date_group: dateGroupFor(item),
      page_type: pageType,
      title,
      detail,
      url,
      video_id: videoIdFromUrl(url),
      playlist_id: parsed.searchParams.get("list"),
    });
  }

  return result;
}

function dedupeRows<T extends { source: string; url: string; title?: string; detail?: string }>(rows: T[]) {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.source}\n${row.url}\n${row.title ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

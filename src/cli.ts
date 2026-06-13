#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fetchTranscript } from "@egoist/youtube-transcript-plus";
import { exportPageHistory } from "./page-history";
import { exportWhatsappWeb, logWhatsappWeb } from "./whatsapp-web";
import {
  attachYoutubeHistoryItemVideoId,
  DEFAULT_WHATSAPP_DB,
  DEFAULT_YOUTUBE_DB,
  getKnownYoutubeItemIds,
  getLatestYoutubeRun,
  getLatestYoutubeRowsFromDb,
  getYoutubeVideoTranscriptText,
  getYoutubeVideoFromDb,
  saveWhatsappExportToDb,
  saveWhatsappRunToDb,
  saveYoutubeTranscriptToDb,
  saveYoutubeRowsToDb,
  youtubeHistoryItemId,
  whatsappShapeText,
  youtubeShapeText,
  type YoutubeHistoryRow,
} from "./history-db";

type ProfileKey = string;

type ChromeProfile = {
  key: ProfileKey;
  label: string;
  email: string;
  dir: string;
};

const CHROME_ROOT = join(homedir(), "Library/Application Support/Google/Chrome");
const APP_ROOT = resolve(import.meta.dir, "..");
const YOUTUBE_MUSIC_TRANSCRIPT_MIN_SECONDS = 10 * 60;
const BUILT_IN_PROFILES: Record<ProfileKey, ChromeProfile> = {
  default: {
    key: "default",
    label: "Default",
    email: "",
    dir: join(CHROME_ROOT, "Default"),
  },
  "profile-1": {
    key: "profile-1",
    label: "Profile 1",
    email: "",
    dir: join(CHROME_ROOT, "Profile 1"),
  },
};

type SamConfig = {
  defaultProfile?: string;
  profiles?: Record<string, Partial<Omit<ChromeProfile, "key">>>;
};

function printHelp() {
  console.log(`sam-cli

Usage:
  sam <command> [options]

Commands:
  export-youtube-history   Export from the actual YouTube + YouTube Music history pages
  sync-youtube-delta       Store new long videos/podcasts and fetch missing transcripts
  export-whatsapp-web      Export visible WhatsApp Web chats or messages
  log-whatsapp-web         Open visible WhatsApp chats and append last messages to a run log
  ingest-youtube-export    Save an existing YouTube JSON export to SQLite
  ingest-whatsapp-log      Save an existing WhatsApp JSON/JSONL log to SQLite
  add-youtube-transcript   Attach transcript text to a YouTube video_id
  fetch-youtube-transcript Fetch transcript from YouTube captions and save it
  youtube-latest           Read latest long-form YouTube/podcast watch rows from SQLite
  youtube-video            Read stored data for one YouTube video, optionally transcript
  show-youtube-video       Show stored metadata/transcript status for a video_id
  show-data-shape          Print the SQLite data shape

Options for export-youtube-history:
  --profile <name|path>       Chrome profile from config, built-in name, directory name, or path
  --chrome-profile-dir <path> Explicit Chrome profile directory
  --profile-label <label>     Label to store in exports/DB rows
  --profile-email <email>     Email/account hint to store in exports/DB rows
  --service <youtube|music|both>
                             History page to scrape (default: both)
  --out <path>               Output JSON path
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})
  --no-db                    Skip writing rows to SQLite
  --no-transcripts           Skip automatic transcript fetching for long/watch videos
  --transcript-limit <num>   Max missing transcripts to fetch per sync (default: 20)
  --transcript-language <code>
                             Preferred transcript language
  --max-scrolls <number>     Page scroll passes per service (default: 8)
  --headless                 Run Chrome headless instead of visibly
  --keep-profile             Keep the temporary cloned browser profile for debugging
  --help                     Show help

Options for sync-youtube-delta:
  --profile <name|path>       Chrome profile from config, built-in name, directory name, or path
  --chrome-profile-dir <path> Explicit Chrome profile directory
  --profile-label <label>     Label to store in exports/DB rows
  --profile-email <email>     Email/account hint to store in exports/DB rows
  --out <path>               Raw output JSON path
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})
  --transcript-limit <num>   Max missing transcripts to fetch per sync (default: 20)
  --transcript-language <code>
                             Preferred transcript language
  --max-scrolls <number>     Page scroll passes per service (default: 8)
  --headless                 Run Chrome headless instead of visibly
  --keep-profile             Keep the temporary cloned browser profile for debugging
  --json                     Print JSON instead of text

Options for ingest-youtube-export:
  --in <path>                Existing YouTube JSON export path
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for ingest-whatsapp-log:
  --in <path>                Existing WhatsApp JSON snapshot or JSONL log path
  --db <path>                SQLite DB path (default: ${DEFAULT_WHATSAPP_DB})

Options for add-youtube-transcript:
  --video-id <id>            YouTube video ID
  --file <path>              Transcript text file
  --text <text>              Transcript text inline
  --language <code>          Transcript language (default: unknown)
  --source <name>            Transcript source (default: manual)
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for fetch-youtube-transcript:
  --video-id <id>            YouTube video ID or URL
  --language <code>          Preferred transcript language
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for show-youtube-video:
  --video-id <id>            YouTube video ID
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for youtube-latest:
  --limit <number>           Number of rows to show (default: 10)
  --service <youtube|music|both>
                             Filter service (default: both)
  --include-shorts           Include Shorts in the output
  --json                     Print JSON instead of text
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for youtube-video:
  --video-id <id>            YouTube video ID or URL
  --transcript               Include latest transcript excerpt
  --transcript-chars <num>   Max transcript characters to print (default: 4000)
  --json                     Print JSON instead of text
  --db <path>                SQLite DB path (default: ${DEFAULT_YOUTUBE_DB})

Options for export-whatsapp-web:
  --profile <name|path>       Chrome profile from config, built-in name, directory name, or path
  --chrome-profile-dir <path> Explicit Chrome profile directory
  --profile-label <label>     Label to store in exports/DB rows
  --profile-email <email>     Email/account hint to store in exports/DB rows
  --list-chats               Export visible chat list/previews instead of messages
  --chat <name>              Click a visible matching chat before exporting messages
  --chat-index <number>      Click a visible chat by index from --list-chats
  --out <path>               Output JSON path
  --db <path>                SQLite DB path (default: ${DEFAULT_WHATSAPP_DB})
  --no-db                    Skip writing rows to SQLite
  --max-scrolls <number>     Message-pane upward scroll passes (default: 8)
  --headless                 Run Chrome headless instead of visibly
  --keep-profile             Keep the temporary cloned browser profile for debugging
  --help                     Show help

Options for log-whatsapp-web:
  --profile <name|path>       Chrome profile from config, built-in name, directory name, or path
  --chrome-profile-dir <path> Explicit Chrome profile directory
  --profile-label <label>     Label to store in exports/DB rows
  --profile-email <email>     Email/account hint to store in exports/DB rows
  --chats <number>           Number of visible chats to enter/read (default: 20)
  --messages <number>        Last messages to keep per chat (default: 5)
  --max-scrolls <number>     Message-pane upward scroll passes per chat (default: 2)
  --out <path>               Output JSON snapshot path
  --log <path>               Append-only JSONL log path
  --db <path>                SQLite DB path (default: ${DEFAULT_WHATSAPP_DB})
  --no-db                    Skip writing rows to SQLite
  --headless                 Run Chrome headless instead of visibly
  --keep-profile             Keep the temporary cloned browser profile for debugging
  --help                     Show help
`);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const opts: {
    command: string | undefined;
    profile: ProfileKey;
    chromeProfileDir?: string;
    profileLabel?: string;
    profileEmail?: string;
    service: "youtube" | "music" | "both";
    out?: string;
    input?: string;
    file?: string;
    text?: string;
    videoId?: string;
    language?: string;
    source?: string;
    chat?: string;
    chatIndex?: number;
    chatLimit: number;
    limit: number;
    messagesPerChat: number;
    logPath?: string;
    dbPath?: string;
    writeDb: boolean;
    fetchTranscripts: boolean;
    transcriptLimit: number;
    transcriptChars: number;
    transcriptLanguage?: string;
    includeShorts: boolean;
    includeTranscript: boolean;
    json: boolean;
    listChats: boolean;
    maxScrolls: number;
    headless: boolean;
    keepProfile: boolean;
    help: boolean;
  } = {
    command,
    profile: "",
    service: "both",
    chatLimit: 20,
    limit: 10,
    messagesPerChat: 5,
    writeDb: true,
    fetchTranscripts: true,
    transcriptLimit: 20,
    transcriptChars: 4000,
    includeShorts: false,
    includeTranscript: false,
    json: false,
    listChats: false,
    maxScrolls: 8,
    headless: false,
    keepProfile: false,
    help: command === "--help" || command === "-h" || !command,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--headless") {
      opts.headless = true;
    } else if (arg === "--keep-profile") {
      opts.keepProfile = true;
    } else if (arg === "--no-db") {
      opts.writeDb = false;
    } else if (arg === "--no-transcripts") {
      opts.fetchTranscripts = false;
    } else if (arg === "--include-shorts") {
      opts.includeShorts = true;
    } else if (arg === "--transcript") {
      opts.includeTranscript = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--list-chats") {
      opts.listChats = true;
    } else if (arg === "--chat") {
      assertValue(arg, next);
      opts.chat = next;
      i += 1;
    } else if (arg === "--chat-index") {
      assertValue(arg, next);
      opts.chatIndex = parseNonNegativeInt("--chat-index", next);
      i += 1;
    } else if (arg === "--chats") {
      assertValue(arg, next);
      opts.chatLimit = parsePositiveInt("--chats", next);
      i += 1;
    } else if (arg === "--limit") {
      assertValue(arg, next);
      opts.limit = parsePositiveInt("--limit", next);
      i += 1;
    } else if (arg === "--messages") {
      assertValue(arg, next);
      opts.messagesPerChat = parsePositiveInt("--messages", next);
      i += 1;
    } else if (arg === "--transcript-limit") {
      assertValue(arg, next);
      opts.transcriptLimit = parseNonNegativeInt("--transcript-limit", next);
      i += 1;
    } else if (arg === "--transcript-chars") {
      assertValue(arg, next);
      opts.transcriptChars = parsePositiveInt("--transcript-chars", next);
      i += 1;
    } else if (arg === "--transcript-language") {
      assertValue(arg, next);
      opts.transcriptLanguage = next;
      i += 1;
    } else if (arg === "--log") {
      assertValue(arg, next);
      opts.logPath = next;
      i += 1;
    } else if (arg === "--db") {
      assertValue(arg, next);
      opts.dbPath = next;
      i += 1;
    } else if (arg === "--file") {
      assertValue(arg, next);
      opts.file = next;
      i += 1;
    } else if (arg === "--text") {
      assertValue(arg, next);
      opts.text = next;
      i += 1;
    } else if (arg === "--video-id") {
      assertValue(arg, next);
      opts.videoId = next;
      i += 1;
    } else if (arg === "--language") {
      assertValue(arg, next);
      opts.language = next;
      i += 1;
    } else if (arg === "--source") {
      assertValue(arg, next);
      opts.source = next;
      i += 1;
    } else if (arg === "--profile") {
      assertValue(arg, next);
      opts.profile = next as ProfileKey;
      i += 1;
    } else if (arg === "--chrome-profile-dir") {
      assertValue(arg, next);
      opts.chromeProfileDir = next;
      i += 1;
    } else if (arg === "--profile-label") {
      assertValue(arg, next);
      opts.profileLabel = next;
      i += 1;
    } else if (arg === "--profile-email") {
      assertValue(arg, next);
      opts.profileEmail = next;
      i += 1;
    } else if (arg === "--service") {
      assertValue(arg, next);
      if (!["youtube", "music", "both"].includes(next)) throw new Error(`Unknown service: ${next}`);
      opts.service = next as "youtube" | "music" | "both";
      i += 1;
    } else if (arg === "--out") {
      assertValue(arg, next);
      opts.out = next;
      i += 1;
    } else if (arg === "--in") {
      assertValue(arg, next);
      opts.input = next;
      i += 1;
    } else if (arg === "--max-scrolls") {
      assertValue(arg, next);
      opts.maxScrolls = parsePositiveInt("--max-scrolls", next);
      i += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function assertValue(flag: string, value: string | undefined): asserts value is string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
}

function parsePositiveInt(flag: string, value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(flag: string, value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function defaultProjectPath(relativePath: string) {
  return join(APP_ROOT, relativePath);
}

function cliPath(value: string | undefined, defaultRelativePath: string) {
  return value ? resolve(value) : defaultProjectPath(defaultRelativePath);
}

function expandHome(value: string) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function loadConfig() {
  const config: SamConfig = {};
  for (const path of [join(APP_ROOT, ".samrc.json"), join(homedir(), ".sam-cli.json")]) {
    if (!existsSync(path)) continue;
    const partial = JSON.parse(readFileSync(path, "utf8")) as SamConfig;
    Object.assign(config, partial);
    config.profiles = { ...(config.profiles ?? {}), ...(partial.profiles ?? {}) };
  }
  return config;
}

function resolveChromeProfile(options: {
  profile: string;
  chromeProfileDir?: string;
  profileLabel?: string;
  profileEmail?: string;
}) {
  const config = loadConfig();
  const key = options.profile || process.env.SAM_PROFILE || config.defaultProfile || "default";
  const configured = config.profiles?.[key];
  const builtIn = BUILT_IN_PROFILES[key];
  const rawDir = options.chromeProfileDir ?? configured?.dir ?? builtIn?.dir ?? key;
  const looksLikePath = rawDir.includes("/") || rawDir.startsWith(".");
  const dir = looksLikePath ? resolve(expandHome(rawDir)) : join(CHROME_ROOT, rawDir);

  return {
    key,
    label: options.profileLabel ?? configured?.label ?? builtIn?.label ?? key,
    email: options.profileEmail ?? configured?.email ?? builtIn?.email ?? "",
    dir,
  };
}

function normalizeYoutubeVideoId(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? value;
    const parts = url.pathname.split("/").filter(Boolean);
    return url.searchParams.get("v") ?? (parts[0] === "shorts" ? parts[1] ?? value : value);
  } catch {
    return value;
  }
}

async function fetchMissingTranscriptsForRows(options: {
  dbPath: string;
  rows: Array<YoutubeHistoryRow>;
  limit: number;
  language?: string;
}) {
  if (options.limit === 0) return { attempted: 0, saved: 0, skippedExisting: 0, failed: 0 };

  const seen = new Set<string>();
  const candidatesByService = new Map<string, Array<TranscriptCandidate>>();
  for (const row of options.rows) {
    const candidate = transcriptCandidateFromRow(row);
    if (!candidate) continue;
    const seenKey = candidate.video_id ?? candidate.searchQuery ?? `${candidate.service}:${candidate.title}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    const candidates = candidatesByService.get(row.service) ?? [];
    candidates.push(candidate);
    candidatesByService.set(row.service, candidates);
  }

  const orderedCandidates: TranscriptCandidate[] = [];
  const serviceQueues = Array.from(candidatesByService.values());
  while (serviceQueues.some((queue) => queue.length > 0)) {
    for (const queue of serviceQueues) {
      const candidate = queue.shift();
      if (candidate) orderedCandidates.push(candidate);
    }
  }

  let attempted = 0;
  let saved = 0;
  let skippedExisting = 0;
  let failed = 0;

  for (const candidate of orderedCandidates) {
    const resolvedVideoId = candidate.video_id ?? await resolveYoutubeVideoIdForPodcast(candidate);
    if (!resolvedVideoId) {
      failed += 1;
      console.warn(`Transcript fetch failed for ${candidate.title} (${candidate.service}): could not resolve a YouTube video ID`);
      continue;
    }
    if (!candidate.video_id && candidate.item_id) {
      attachYoutubeHistoryItemVideoId(options.dbPath, candidate.item_id, resolvedVideoId, candidate.title);
    }

    const existing = getYoutubeVideoFromDb(options.dbPath, resolvedVideoId);
    if (existing.transcripts.length > 0) {
      skippedExisting += 1;
      continue;
    }
    if (attempted >= options.limit) break;
    attempted += 1;

    try {
      const transcript = await fetchTranscript(resolvedVideoId, {
        lang: options.language,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      });
      const transcriptText = decodeHtmlEntities(transcript.segments.map((segment) => segment.text).join("\n"));
      const language = options.language ?? transcript.segments.find((segment) => segment.lang)?.lang ?? "unknown";
      saveYoutubeTranscriptToDb(options.dbPath, {
        videoId: resolvedVideoId,
        transcriptText,
        language,
        source: "youtube-transcript-plus",
      });
      saved += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Transcript fetch failed for ${resolvedVideoId} (${candidate.service}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { attempted, saved, skippedExisting, failed };
}

type TranscriptCandidate = {
  video_id: string | null;
  title: string;
  detail: string;
  url: string;
  service: string;
  expectedDurationSeconds: number | null;
  item_id?: string;
  searchQuery?: string;
};

function transcriptCandidateFromRow(row: Pick<YoutubeHistoryRow, "email" | "video_id" | "playlist_id" | "date_group" | "page_type" | "service" | "title" | "detail" | "url">): TranscriptCandidate | null {
  const item_id = youtubeHistoryItemId(row);
  if (row.service !== "youtube_music") {
    if (!row.video_id || row.page_type !== "watch") return null;
    return { ...row, item_id, expectedDurationSeconds: durationFromText(`${row.title} ${row.detail} ${row.url}`) };
  }

  const durationSeconds = durationFromText(`${row.title} ${row.detail} ${row.url}`);
  if (durationSeconds === null || durationSeconds < YOUTUBE_MUSIC_TRANSCRIPT_MIN_SECONDS) return null;

  if (row.video_id && row.page_type === "watch") {
    return { ...row, item_id, expectedDurationSeconds: durationSeconds };
  }

  return {
    ...row,
    item_id,
    expectedDurationSeconds: durationSeconds,
    searchQuery: youtubeSearchQueryForMusicPodcast(row),
  };
}

function durationFromText(value: string) {
  const matches = value.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g);
  if (!matches?.length) return null;
  const duration = matches[matches.length - 1];
  const parts = duration.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  return (parts[0] * 60) + parts[1];
}

function youtubeSearchQueryForMusicPodcast(row: { title: string; detail: string }) {
  const withoutDuration = row.detail.replace(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, " ");
  return `${row.title} ${withoutDuration}`.replace(/\s+/g, " ").trim();
}

async function resolveYoutubeVideoIdForPodcast(candidate: TranscriptCandidate) {
  if (!candidate.searchQuery) return null;
  const videos = await searchYoutubeVideos(candidate.searchQuery);
  if (videos.length === 0) return null;

  const expected = candidate.expectedDurationSeconds;
  const closeDuration = expected
    ? videos.find((video) => Math.abs(video.seconds - expected) <= 5 * 60)
    : undefined;
  return (closeDuration ?? videos[0]).videoId;
}

type YoutubeSearchVideo = {
  videoId: string;
  seconds: number;
};

async function searchYoutubeVideos(query: string): Promise<YoutubeSearchVideo[]> {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);

  const response = await fetch(url, {
    headers: {
      "accept-language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 sam-cli",
    },
  });
  if (!response.ok) throw new Error(`YouTube search failed with HTTP ${response.status}`);

  const page = await response.text();
  const initialData = extractYoutubeInitialData(page);
  if (!initialData) return [];

  const videos: YoutubeSearchVideo[] = [];
  collectYoutubeSearchVideos(initialData, videos);
  return videos
    .filter((video) => video.seconds >= YOUTUBE_MUSIC_TRANSCRIPT_MIN_SECONDS)
    .slice(0, 12);
}

function extractYoutubeInitialData(page: string) {
  const marker = "ytInitialData";
  const markerIndex = page.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = page.indexOf("{", markerIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < page.length; i += 1) {
    const char = page[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(page.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function collectYoutubeSearchVideos(value: unknown, videos: YoutubeSearchVideo[]) {
  if (!value || typeof value !== "object") return;

  if ("videoRenderer" in value) {
    const renderer = (value as { videoRenderer?: Record<string, unknown> }).videoRenderer;
    const videoId = typeof renderer?.videoId === "string" ? renderer.videoId : null;
    const lengthText = textFromYoutubeRuns(renderer?.lengthText);
    const seconds = lengthText ? durationFromText(lengthText) : null;
    if (videoId && seconds !== null) videos.push({ videoId, seconds });
  }

  for (const child of Object.values(value)) {
    if (videos.length >= 24) return;
    if (child && typeof child === "object") collectYoutubeSearchVideos(child, videos);
  }
}

function textFromYoutubeRuns(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const simpleText = (value as { simpleText?: unknown }).simpleText;
  if (typeof simpleText === "string") return simpleText;

  const runs = (value as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return null;
  return runs
    .map((run) => (run && typeof run === "object" && typeof (run as { text?: unknown }).text === "string" ? (run as { text: string }).text : ""))
    .join("");
}

type LatestRow = ReturnType<typeof getLatestYoutubeRowsFromDb>[number];
type TranscriptSyncResult = Awaited<ReturnType<typeof fetchMissingTranscriptsForRows>>;

function serviceMatches(row: LatestRow, service: "youtube" | "music" | "both") {
  if (service === "both") return true;
  return service === "music" ? row.service === "youtube_music" : row.service === "youtube";
}

function isLatestReadableRow(row: LatestRow, includeShorts: boolean) {
  if (row.service === "youtube_music") {
    return durationFromText(`${row.title} ${row.detail} ${row.url}`) !== null
      && (durationFromText(`${row.title} ${row.detail} ${row.url}`) ?? 0) >= YOUTUBE_MUSIC_TRANSCRIPT_MIN_SECONDS;
  }
  if (includeShorts && row.page_type === "shorts") return true;
  return row.page_type === "watch";
}

function latestRowsForDisplay(rows: LatestRow[], options: { service: "youtube" | "music" | "both"; includeShorts: boolean; limit: number }) {
  return rows
    .filter((row) => serviceMatches(row, options.service))
    .filter((row) => isLatestReadableRow(row, options.includeShorts))
    .slice(0, options.limit);
}

function isYoutubeDeltaSyncRow(row: YoutubeHistoryRow) {
  return transcriptCandidateFromRow(row) !== null;
}

function printYoutubeDelta(options: {
  previousRun: ReturnType<typeof getLatestYoutubeRun>;
  exportedRows: number;
  storedRows: number;
  newRows: YoutubeHistoryRow[];
  transcriptResult: TranscriptSyncResult;
  dbPath: string;
  out: string;
}) {
  console.log(`YouTube delta since ${options.previousRun?.exported_at ?? "first sync"}`);
  console.log(`New videos/podcasts: ${options.newRows.length}`);
  console.log(`Stored eligible rows: ${options.storedRows} (${options.exportedRows} scraped total)`);
  console.log(
    `Transcript sync: attempted ${options.transcriptResult.attempted}, saved ${options.transcriptResult.saved}, skipped existing ${options.transcriptResult.skippedExisting}, failed ${options.transcriptResult.failed}`,
  );
  console.log(`DB: ${options.dbPath}`);
  console.log(`Raw export: ${options.out}`);

  if (options.newRows.length === 0) return;

  console.log("");
  for (const [index, row] of options.newRows.slice(0, 20).entries()) {
    console.log(`${index + 1}. [${row.service}] ${row.date_group ?? "unknown date"} | ${row.page_type} | ${displayTitle(row)}`);
    console.log(`   ${row.video_id ? `video_id: ${row.video_id}` : "video_id: none"} | ${row.url}`);
  }
  if (options.newRows.length > 20) {
    console.log(`...and ${options.newRows.length - 20} more new rows`);
  }
}

function youtubeDeltaJson(options: {
  previousRun: ReturnType<typeof getLatestYoutubeRun>;
  exportedRows: number;
  storedRows: number;
  newRows: YoutubeHistoryRow[];
  transcriptResult: TranscriptSyncResult;
  dbPath: string;
  out: string;
}) {
  return {
    previous_run: options.previousRun,
    exported_rows: options.exportedRows,
    stored_rows: options.storedRows,
    new_videos_or_podcasts: options.newRows.length,
    transcript_sync: options.transcriptResult,
    db: options.dbPath,
    raw_export: options.out,
    new_rows: options.newRows,
  };
}

function displayTitle(row: { title: string; detail: string }) {
  const title = row.title.trim();
  if (/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.test(title)) {
    return row.detail.replace(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+/, "").trim();
  }
  return title || row.detail;
}

function printLatestRows(rows: LatestRow[]) {
  if (rows.length === 0) {
    console.log("No matching rows found.");
    return;
  }
  for (const [index, row] of rows.entries()) {
    const transcript = row.transcript_characters
      ? `transcript: ${row.transcript_characters} chars`
      : `transcript: ${row.transcript_status ?? "none"}`;
    console.log(`${index + 1}. [${row.service}] ${row.date_group ?? "unknown date"} | ${row.page_type} | ${displayTitle(row)}`);
    console.log(`   ${row.video_id ? `video_id: ${row.video_id}` : "video_id: none"} | ${transcript}`);
    console.log(`   ${row.url}`);
  }
}

function printYoutubeVideo(value: ReturnType<typeof getYoutubeVideoFromDb>, transcriptText: ReturnType<typeof getYoutubeVideoTranscriptText> | null, transcriptChars: number) {
  const decodedTranscript = transcriptText ? decodeHtmlEntities(transcriptText.transcript_text) : null;
  console.log(JSON.stringify({
    ...value,
    transcript_excerpt: transcriptText
      ? {
          transcript_id: transcriptText.transcript_id,
          language: transcriptText.language,
          source: transcriptText.source,
          fetched_at: transcriptText.fetched_at,
          characters: decodedTranscript?.length ?? 0,
          text: decodedTranscript?.slice(0, transcriptChars) ?? "",
          truncated: (decodedTranscript?.length ?? 0) > transcriptChars,
        }
      : null,
  }, null, 2));
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&amp;quot;/g, "\"")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;apos;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;lt;/g, "<")
    .replace(/&lt;/g, "<")
    .replace(/&amp;gt;/g, ">")
    .replace(/&gt;/g, ">")
    .replace(/&amp;amp;/g, "&")
    .replace(/&amp;/g, "&");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  const chromeProfile = resolveChromeProfile(opts);
  if (opts.command === "show-data-shape") {
    console.log(`${youtubeShapeText()}\n\n${whatsappShapeText()}`);
    return;
  }
  if (opts.command === "ingest-youtube-export") {
    if (!opts.input) throw new Error("ingest-youtube-export requires --in <path>");
    const input = resolve(opts.input);
    const rows = JSON.parse(readFileSync(input, "utf8"));
    if (!Array.isArray(rows)) throw new Error(`Expected ${input} to contain a JSON array`);
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const dbResult = saveYoutubeRowsToDb(dbPath, rows);
    console.log(`Ingested ${dbResult.rows} YouTube rows from ${input} into ${dbResult.dbPath}`);
    return;
  }
  if (opts.command === "ingest-whatsapp-log") {
    if (!opts.input) throw new Error("ingest-whatsapp-log requires --in <path>");
    const input = resolve(opts.input);
    const dbPath = cliPath(opts.dbPath, DEFAULT_WHATSAPP_DB);
    const text = readFileSync(input, "utf8").trim();
    if (!text) throw new Error(`${input} is empty`);

    const runs = text.startsWith("{")
      ? [JSON.parse(text)]
      : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    let chats = 0;
    let messages = 0;
    for (const run of runs) {
      const dbResult = saveWhatsappRunToDb(dbPath, run);
      chats += dbResult.chats;
      messages += dbResult.messages;
    }
    console.log(`Ingested ${runs.length} WhatsApp run(s), ${chats} chat snapshots, ${messages} messages from ${input} into ${dbPath}`);
    return;
  }
  if (opts.command === "add-youtube-transcript") {
    if (!opts.videoId) throw new Error("add-youtube-transcript requires --video-id <id>");
    if (!opts.file && !opts.text) throw new Error("add-youtube-transcript requires --file <path> or --text <text>");
    const videoId = normalizeYoutubeVideoId(opts.videoId);
    const transcriptText = opts.file ? readFileSync(resolve(opts.file), "utf8") : opts.text ?? "";
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const dbResult = saveYoutubeTranscriptToDb(dbPath, {
      videoId,
      transcriptText,
      language: opts.language,
      source: opts.source,
    });
    console.log(`Saved transcript for ${dbResult.videoId} to ${dbResult.dbPath} (${dbResult.characters} characters)`);
    return;
  }
  if (opts.command === "fetch-youtube-transcript") {
    if (!opts.videoId) throw new Error("fetch-youtube-transcript requires --video-id <id>");
    const videoId = normalizeYoutubeVideoId(opts.videoId);
    const transcript = await fetchTranscript(videoId, {
      lang: opts.language,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    const transcriptText = decodeHtmlEntities(transcript.segments.map((segment) => segment.text).join("\n"));
    const language = opts.language ?? transcript.segments.find((segment) => segment.lang)?.lang ?? "unknown";
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const dbResult = saveYoutubeTranscriptToDb(dbPath, {
      videoId,
      transcriptText,
      language,
      source: "youtube-transcript-plus",
    });
    console.log(`Fetched transcript "${transcript.title}" (${transcript.segments.length} segments)`);
    console.log(`Saved transcript for ${dbResult.videoId} to ${dbResult.dbPath} (${dbResult.characters} characters)`);
    return;
  }
  if (opts.command === "show-youtube-video") {
    if (!opts.videoId) throw new Error("show-youtube-video requires --video-id <id>");
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    console.log(JSON.stringify(getYoutubeVideoFromDb(dbPath, normalizeYoutubeVideoId(opts.videoId)), null, 2));
    return;
  }
  if (opts.command === "sync-youtube-delta") {
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const previousRun = getLatestYoutubeRun(dbPath);
    const knownItemIds = getKnownYoutubeItemIds(dbPath);
    const out = cliPath(opts.out, join("exports", `youtube-delta-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const result = await exportPageHistory({
      profile: chromeProfile,
      service: "both",
      out,
      maxScrolls: opts.maxScrolls,
      headless: opts.headless,
      keepProfile: opts.keepProfile,
    });
    const eligibleRows = (result.rows as YoutubeHistoryRow[]).filter(isYoutubeDeltaSyncRow);
    const newRows = eligibleRows.filter((row) => !knownItemIds.has(youtubeHistoryItemId(row)));
    const dbResult = saveYoutubeRowsToDb(dbPath, eligibleRows);
    const transcriptResult = await fetchMissingTranscriptsForRows({
      dbPath,
      rows: eligibleRows,
      limit: opts.transcriptLimit,
      language: opts.transcriptLanguage,
    });
    const delta = {
      previousRun,
      exportedRows: result.rows.length,
      storedRows: dbResult.rows,
      newRows,
      transcriptResult,
      dbPath,
      out: result.out,
    };
    if (opts.json) console.log(JSON.stringify(youtubeDeltaJson(delta), null, 2));
    else printYoutubeDelta(delta);
    return;
  }
  if (opts.command === "youtube-latest") {
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const rows = latestRowsForDisplay(getLatestYoutubeRowsFromDb(dbPath, Math.max(opts.limit * 8, 200)), {
      service: opts.service,
      includeShorts: opts.includeShorts,
      limit: opts.limit,
    });
    if (opts.json) console.log(JSON.stringify(rows, null, 2));
    else printLatestRows(rows);
    return;
  }
  if (opts.command === "youtube-video") {
    if (!opts.videoId) throw new Error("youtube-video requires --video-id <id>");
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const videoId = normalizeYoutubeVideoId(opts.videoId);
    const data = getYoutubeVideoFromDb(dbPath, videoId);
    const transcriptText = opts.includeTranscript ? getYoutubeVideoTranscriptText(dbPath, videoId) : null;
    if (opts.json) printYoutubeVideo(data, transcriptText, opts.transcriptChars);
    else {
      const history = data.history[0];
      console.log(`video_id: ${videoId}`);
      console.log(`url: https://www.youtube.com/watch?v=${videoId}`);
      if (history) {
        console.log(`latest history: [${history.service}] ${history.date_group ?? "unknown date"} | ${history.page_type}`);
        console.log(`title/detail: ${displayTitle(history)}`);
      }
      console.log(`transcripts: ${data.transcripts.length}`);
      for (const transcript of data.transcripts) {
        console.log(`- ${transcript.language} | ${transcript.source} | ${transcript.characters} chars | ${transcript.fetched_at}`);
      }
      if (transcriptText) {
        const decodedTranscript = decodeHtmlEntities(transcriptText.transcript_text);
        const text = decodedTranscript.slice(0, opts.transcriptChars);
        console.log("");
        console.log(`transcript excerpt (${text.length}/${decodedTranscript.length} chars):`);
        console.log(text);
        if (decodedTranscript.length > opts.transcriptChars) {
          console.log(`\n[truncated at ${opts.transcriptChars} chars; use --transcript-chars to read more]`);
        }
      }
    }
    return;
  }
  if (opts.command === "export-whatsapp-web") {
    const out = cliPath(opts.out, join("exports", `whatsapp-web-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const result = await exportWhatsappWeb({
      profile: chromeProfile,
      out,
      chat: opts.chat,
      chatIndex: opts.chatIndex,
      listChats: opts.listChats,
      maxScrolls: opts.maxScrolls,
      headless: opts.headless,
      keepProfile: opts.keepProfile,
    });
    const count = result.exportData.mode === "chat_list"
      ? result.exportData.chats?.length ?? 0
      : result.exportData.messages?.length ?? 0;
    console.log(`Exported ${count} WhatsApp Web ${result.exportData.mode === "chat_list" ? "chats" : "messages"} to ${result.out}`);
    if (opts.writeDb) {
      const dbPath = cliPath(opts.dbPath, DEFAULT_WHATSAPP_DB);
      const dbResult = saveWhatsappExportToDb(dbPath, result.exportData);
      console.log(`Saved WhatsApp data to ${dbResult.dbPath} (${dbResult.chats} chats, ${dbResult.messages} messages)`);
    }
    return;
  }

  if (opts.command === "log-whatsapp-web") {
    const out = cliPath(opts.out, join("exports", `whatsapp-log-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const logPath = cliPath(opts.logPath, join("logs", "whatsapp-web-conversation-log.jsonl"));
    const result = await logWhatsappWeb({
      profile: chromeProfile,
      out,
      logPath,
      chatLimit: opts.chatLimit,
      messagesPerChat: opts.messagesPerChat,
      maxScrolls: opts.maxScrolls,
      headless: opts.headless,
      keepProfile: opts.keepProfile,
    });
    console.log(`Logged ${result.run.logged_chat_count}/${result.run.chats.length} WhatsApp chats to ${result.logPath}`);
    console.log(`Snapshot saved to ${result.out}`);
    if (opts.writeDb) {
      const dbPath = cliPath(opts.dbPath, DEFAULT_WHATSAPP_DB);
      const dbResult = saveWhatsappRunToDb(dbPath, result.run);
      console.log(`Saved WhatsApp data to ${dbResult.dbPath} (${dbResult.chats} chats, ${dbResult.messages} messages)`);
    }
    return;
  }

  if (opts.command !== "export-youtube-history") {
    throw new Error(`Unknown command: ${opts.command}`);
  }

  const out = cliPath(opts.out, join("exports", `youtube-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  const result = await exportPageHistory({
    profile: chromeProfile,
    service: opts.service,
    out,
    maxScrolls: opts.maxScrolls,
    headless: opts.headless,
    keepProfile: opts.keepProfile,
  });

  console.log(`Exported ${result.rows.length} rows from YouTube / YouTube Music history pages to ${result.out}`);
  if (opts.writeDb) {
    const dbPath = cliPath(opts.dbPath, DEFAULT_YOUTUBE_DB);
    const dbResult = saveYoutubeRowsToDb(dbPath, result.rows);
    console.log(`Saved YouTube data to ${dbResult.dbPath} (${dbResult.rows} rows)`);
    if (opts.fetchTranscripts) {
      const transcriptResult = await fetchMissingTranscriptsForRows({
        dbPath,
        rows: result.rows,
        limit: opts.transcriptLimit,
        language: opts.transcriptLanguage,
      });
      console.log(
        `Transcript sync: attempted ${transcriptResult.attempted}, saved ${transcriptResult.saved}, skipped existing ${transcriptResult.skippedExisting}, failed ${transcriptResult.failed}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

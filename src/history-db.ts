import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type YoutubeHistoryRow = {
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

export type WhatsappMessage = {
  direction: "in" | "out" | "unknown";
  timestamp: string | null;
  sender: string | null;
  text: string;
};

export type WhatsappRunLog = {
  run_id: string;
  exported_at: string;
  profile: string;
  email: string;
  chat_limit?: number;
  messages_per_chat?: number;
  visible_chat_count?: number;
  logged_chat_count?: number;
  chats: Array<{
    index: number;
    title: string;
    preview: string;
    messages: WhatsappMessage[];
    error?: string;
  }>;
};

export type WhatsappExport = {
  exported_at: string;
  profile: string;
  email: string;
  mode: "chat_list" | "messages";
  selected_chat: string | null;
  chats?: Array<{ index: number; title: string; preview: string }>;
  messages?: WhatsappMessage[];
};

export type YoutubeTranscriptInput = {
  videoId: string;
  transcriptText: string;
  language?: string | null;
  source?: string | null;
  fetchedAt?: string;
};

export type YoutubeLatestRow = {
  run_id: string;
  exported_at: string;
  position_in_run: number;
  item_id: string;
  service: "youtube" | "youtube_music";
  date_group: string | null;
  page_type: string;
  title: string;
  detail: string;
  url: string;
  video_id: string | null;
  playlist_id: string | null;
  transcript_status: string | null;
  transcript_characters: number | null;
};

export const DEFAULT_YOUTUBE_DB = "data/youtube-history.sqlite";
export const DEFAULT_WHATSAPP_DB = "data/whatsapp-history.sqlite";

export function saveYoutubeRowsToDb(dbPath: string, rows: YoutubeHistoryRow[], exportedAt = new Date().toISOString()) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureYoutubeSchema(db);

  const runId = stableHash(["youtube-run", exportedAt, rows.length, rows.map((row) => row.url).join("|")]);
  const insertRun = db.prepare(`
    INSERT OR IGNORE INTO youtube_import_runs (run_id, exported_at, row_count)
    VALUES (?, ?, ?)
  `);
  const upsertVideo = db.prepare(`
    INSERT INTO youtube_videos (
      video_id, canonical_url, first_title, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      canonical_url = COALESCE(excluded.canonical_url, youtube_videos.canonical_url),
      first_title = COALESCE(youtube_videos.first_title, excluded.first_title),
      last_seen_at = excluded.last_seen_at
  `);
  const upsertItem = db.prepare(`
    INSERT INTO youtube_history_items (
      item_id, run_id, source, service, date_group, page_type, title, detail, url,
      video_id, playlist_id, profile, email, first_seen_at, last_seen_at, seen_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(item_id) DO UPDATE SET
      run_id = excluded.run_id,
      title = excluded.title,
      detail = excluded.detail,
      date_group = excluded.date_group,
      last_seen_at = excluded.last_seen_at,
      seen_count = youtube_history_items.seen_count + 1
  `);
  const insertRunItem = db.prepare(`
    INSERT OR REPLACE INTO youtube_run_items (run_id, item_id, position_in_run)
    VALUES (?, ?, ?)
  `);
  const deleteFts = db.prepare("DELETE FROM youtube_history_fts WHERE item_id = ?");
  const insertFts = db.prepare(`
    INSERT INTO youtube_history_fts (item_id, title, detail, url, video_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const write = db.transaction(() => {
    insertRun.run(runId, exportedAt, rows.length);
    for (const [position, row] of rows.entries()) {
      const itemId = stableHash([
        row.email,
        row.service,
        row.video_id ?? row.url,
        row.playlist_id ?? "",
        row.date_group ?? "",
        row.page_type,
      ]);

      if (row.video_id) {
        upsertVideo.run(row.video_id, canonicalYoutubeUrl(row.video_id), row.title, exportedAt, exportedAt);
      }

      upsertItem.run(
        itemId,
        runId,
        row.source,
        row.service,
        row.date_group,
        row.page_type,
        row.title,
        row.detail,
        row.url,
        row.video_id,
        row.playlist_id,
        row.profile,
        row.email,
        exportedAt,
        exportedAt,
      );
      insertRunItem.run(runId, itemId, position);
      deleteFts.run(itemId);
      insertFts.run(itemId, row.title, row.detail, row.url, row.video_id);
    }
  });

  write();
  db.close();
  return { dbPath, runId, rows: rows.length };
}

export function saveWhatsappRunToDb(dbPath: string, run: WhatsappRunLog) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureWhatsappSchema(db);

  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO whatsapp_import_runs (
      run_id, exported_at, profile, email, chat_limit, messages_per_chat,
      visible_chat_count, logged_chat_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertChat = db.prepare(`
    INSERT INTO whatsapp_chats (
      chat_id, title, profile, email, last_preview, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = excluded.title,
      last_preview = excluded.last_preview,
      last_seen_at = excluded.last_seen_at
  `);
  const insertChatRun = db.prepare(`
    INSERT OR REPLACE INTO whatsapp_run_chats (
      run_id, chat_id, visible_index, preview, message_count, error
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const upsertMessage = db.prepare(`
    INSERT INTO whatsapp_messages (
      message_id, chat_id, run_id, direction, timestamp_text, timestamp_iso,
      sender, text, first_seen_at, last_seen_at, seen_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(message_id) DO UPDATE SET
      run_id = excluded.run_id,
      direction = excluded.direction,
      timestamp_text = COALESCE(excluded.timestamp_text, whatsapp_messages.timestamp_text),
      timestamp_iso = COALESCE(excluded.timestamp_iso, whatsapp_messages.timestamp_iso),
      sender = COALESCE(excluded.sender, whatsapp_messages.sender),
      text = excluded.text,
      last_seen_at = excluded.last_seen_at,
      seen_count = whatsapp_messages.seen_count + 1
  `);
  const deleteFts = db.prepare("DELETE FROM whatsapp_message_fts WHERE message_id = ?");
  const insertFts = db.prepare(`
    INSERT INTO whatsapp_message_fts (message_id, chat_id, sender, text)
    VALUES (?, ?, ?, ?)
  `);

  let messageRows = 0;
  const write = db.transaction(() => {
    insertRun.run(
      run.run_id,
      run.exported_at,
      run.profile,
      run.email,
      run.chat_limit ?? null,
      run.messages_per_chat ?? null,
      run.visible_chat_count ?? null,
      run.logged_chat_count ?? null,
    );

    for (const chat of run.chats) {
      const chatId = stableHash([run.email, chat.title]);
      upsertChat.run(chatId, chat.title, run.profile, run.email, chat.preview, run.exported_at, run.exported_at);
      insertChatRun.run(run.run_id, chatId, chat.index, chat.preview, chat.messages.length, chat.error ?? null);

      for (const message of chat.messages) {
        const messageId = stableHash([
          run.email,
          chatId,
          message.timestamp ?? "",
          message.sender ?? "",
          message.text,
        ]);
        const timestampIso = parseWhatsappTimestamp(message.timestamp);
        upsertMessage.run(
          messageId,
          chatId,
          run.run_id,
          message.direction,
          message.timestamp,
          timestampIso,
          message.sender,
          message.text,
          run.exported_at,
          run.exported_at,
        );
        deleteFts.run(messageId);
        insertFts.run(messageId, chatId, message.sender, message.text);
        messageRows += 1;
      }
    }
  });

  write();
  db.close();
  return { dbPath, runId: run.run_id, chats: run.chats.length, messages: messageRows };
}

export function saveWhatsappExportToDb(dbPath: string, exportData: WhatsappExport) {
  const run: WhatsappRunLog = {
    run_id: `whatsapp-export-${exportData.exported_at.replace(/[:.]/g, "-")}`,
    exported_at: exportData.exported_at,
    profile: exportData.profile,
    email: exportData.email,
    visible_chat_count: exportData.chats?.length,
    logged_chat_count: exportData.messages ? 1 : 0,
    chats: exportData.chats
      ? exportData.chats.map((chat) => ({ ...chat, messages: [] }))
      : [{
          index: 0,
          title: exportData.selected_chat ?? "selected_chat",
          preview: "",
          messages: exportData.messages ?? [],
        }],
  };
  return saveWhatsappRunToDb(dbPath, run);
}

export function saveYoutubeTranscriptToDb(dbPath: string, input: YoutubeTranscriptInput) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureYoutubeSchema(db);

  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const language = input.language ?? "unknown";
  const source = input.source ?? "manual";
  const transcriptId = stableHash(["youtube-transcript", input.videoId, language, source]);

  const write = db.transaction(() => {
    db.prepare(`
      INSERT INTO youtube_videos (
        video_id, canonical_url, transcript_status, transcript_checked_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, 'stored', ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        transcript_status = 'stored',
        transcript_checked_at = excluded.transcript_checked_at,
        last_seen_at = excluded.last_seen_at
    `).run(input.videoId, canonicalYoutubeUrl(input.videoId), fetchedAt, fetchedAt, fetchedAt);

    db.prepare(`
      INSERT INTO youtube_video_transcripts (
        transcript_id, video_id, language, source, transcript_text, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, language, source) DO UPDATE SET
        transcript_text = excluded.transcript_text,
        fetched_at = excluded.fetched_at
    `).run(transcriptId, input.videoId, language, source, input.transcriptText, fetchedAt);
  });

  write();
  db.close();
  return { dbPath, transcriptId, videoId: input.videoId, characters: input.transcriptText.length };
}

export function getYoutubeVideoFromDb(dbPath: string, videoId: string) {
  const db = new Database(dbPath);
  ensureYoutubeSchema(db);
  const video = db.query("SELECT * FROM youtube_videos WHERE video_id = ?").get(videoId);
  const history = db.query(`
    SELECT h.service, h.date_group, h.page_type, h.title, h.detail, h.url, h.first_seen_at, h.last_seen_at, h.seen_count
    FROM youtube_history_items h
    WHERE h.video_id = ?
    ORDER BY h.last_seen_at DESC
  `).all(videoId);
  const transcripts = db.query(`
    SELECT transcript_id, language, source, length(transcript_text) AS characters, fetched_at
    FROM youtube_video_transcripts
    WHERE video_id = ?
    ORDER BY fetched_at DESC
  `).all(videoId);
  const summaries = db.query(`
    SELECT summary_id, summary_version, model, summary, main_points_json, created_at
    FROM youtube_video_summaries
    WHERE video_id = ?
    ORDER BY created_at DESC
  `).all(videoId);
  db.close();
  return { video, history, transcripts, summaries };
}

export function getYoutubeVideoTranscriptText(dbPath: string, videoId: string) {
  const db = new Database(dbPath);
  ensureYoutubeSchema(db);
  const row = db.query(`
    SELECT transcript_id, language, source, transcript_text, fetched_at
    FROM youtube_video_transcripts
    WHERE video_id = ?
    ORDER BY fetched_at DESC
    LIMIT 1
  `).get(videoId);
  db.close();
  return row as { transcript_id: string; language: string; source: string; transcript_text: string; fetched_at: string } | null;
}

export function getLatestYoutubeRowsFromDb(dbPath: string, limit = 200) {
  const db = new Database(dbPath);
  ensureYoutubeSchema(db);
  const run = db.query(`
    SELECT run_id, exported_at
    FROM youtube_import_runs
    ORDER BY exported_at DESC
    LIMIT 1
  `).get() as { run_id: string; exported_at: string } | null;

  if (!run) {
    db.close();
    return [];
  }

  const rows = db.query(`
    SELECT
      r.run_id,
      r.exported_at,
      ri.position_in_run,
      h.item_id,
      h.service,
      h.date_group,
      h.page_type,
      h.title,
      h.detail,
      h.url,
      h.video_id,
      h.playlist_id,
      v.transcript_status,
      length(t.transcript_text) AS transcript_characters
    FROM youtube_run_items ri
    JOIN youtube_import_runs r ON r.run_id = ri.run_id
    JOIN youtube_history_items h ON h.item_id = ri.item_id
    LEFT JOIN youtube_videos v ON v.video_id = h.video_id
    LEFT JOIN youtube_video_transcripts t ON t.video_id = h.video_id
    WHERE ri.run_id = ?
    GROUP BY h.item_id
    ORDER BY ri.position_in_run ASC
    LIMIT ?
  `).all(run.run_id, limit) as YoutubeLatestRow[];
  db.close();
  return rows;
}

export function youtubeShapeText() {
  return `YouTube DB: ${DEFAULT_YOUTUBE_DB}

Main tables:
- youtube_import_runs(run_id, exported_at, row_count)
- youtube_run_items(run_id, item_id, position_in_run)
- youtube_history_items(item_id, run_id, service, date_group, page_type, title, detail, url, video_id, playlist_id, profile, email, first_seen_at, last_seen_at, seen_count)
- youtube_videos(video_id, canonical_url, first_title, channel_name, duration_seconds, transcript_status, transcript_checked_at, first_seen_at, last_seen_at)
- youtube_video_transcripts(transcript_id, video_id, language, source, transcript_text, fetched_at)
- youtube_video_summaries(summary_id, video_id, summary_version, model, summary, main_points_json, created_at)
- youtube_history_fts(item_id, title, detail, url, video_id)

Future enrichment hangs off youtube_videos.video_id, so transcripts, summaries, main points, topics, and embeddings do not duplicate watch-history rows.`;
}

export function whatsappShapeText() {
  return `WhatsApp DB: ${DEFAULT_WHATSAPP_DB}

Main tables:
- whatsapp_import_runs(run_id, exported_at, profile, email, chat_limit, messages_per_chat, visible_chat_count, logged_chat_count)
- whatsapp_chats(chat_id, title, profile, email, last_preview, first_seen_at, last_seen_at)
- whatsapp_run_chats(run_id, chat_id, visible_index, preview, message_count, error)
- whatsapp_messages(message_id, chat_id, run_id, direction, timestamp_text, timestamp_iso, sender, text, first_seen_at, last_seen_at, seen_count)
- whatsapp_message_fts(message_id, chat_id, sender, text)

WhatsApp stays message/conversation-focused and separate from YouTube enrichment data.`;
}

function ensureYoutubeSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS youtube_import_runs (
      run_id TEXT PRIMARY KEY,
      exported_at TEXT NOT NULL,
      row_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS youtube_videos (
      video_id TEXT PRIMARY KEY,
      canonical_url TEXT,
      first_title TEXT,
      channel_name TEXT,
      duration_seconds INTEGER,
      transcript_status TEXT NOT NULL DEFAULT 'pending',
      transcript_checked_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS youtube_history_items (
      item_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES youtube_import_runs(run_id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      service TEXT NOT NULL,
      date_group TEXT,
      page_type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      url TEXT NOT NULL,
      video_id TEXT REFERENCES youtube_videos(video_id) ON DELETE SET NULL,
      playlist_id TEXT,
      profile TEXT NOT NULL,
      email TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS youtube_run_items (
      run_id TEXT NOT NULL REFERENCES youtube_import_runs(run_id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES youtube_history_items(item_id) ON DELETE CASCADE,
      position_in_run INTEGER NOT NULL,
      PRIMARY KEY(run_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS youtube_video_transcripts (
      transcript_id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
      language TEXT,
      source TEXT NOT NULL,
      transcript_text TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      UNIQUE(video_id, language, source)
    );

    CREATE TABLE IF NOT EXISTS youtube_video_summaries (
      summary_id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
      summary_version TEXT NOT NULL,
      model TEXT,
      summary TEXT,
      main_points_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(video_id, summary_version)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS youtube_history_fts
    USING fts5(item_id UNINDEXED, title, detail, url, video_id UNINDEXED);

    CREATE INDEX IF NOT EXISTS youtube_history_items_video_id_idx ON youtube_history_items(video_id);
    CREATE INDEX IF NOT EXISTS youtube_history_items_service_idx ON youtube_history_items(service);
    CREATE INDEX IF NOT EXISTS youtube_history_items_last_seen_idx ON youtube_history_items(last_seen_at);
    CREATE INDEX IF NOT EXISTS youtube_run_items_position_idx ON youtube_run_items(run_id, position_in_run);
  `);
}

function ensureWhatsappSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_import_runs (
      run_id TEXT PRIMARY KEY,
      exported_at TEXT NOT NULL,
      profile TEXT NOT NULL,
      email TEXT NOT NULL,
      chat_limit INTEGER,
      messages_per_chat INTEGER,
      visible_chat_count INTEGER,
      logged_chat_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS whatsapp_chats (
      chat_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      profile TEXT NOT NULL,
      email TEXT NOT NULL,
      last_preview TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_run_chats (
      run_id TEXT NOT NULL REFERENCES whatsapp_import_runs(run_id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES whatsapp_chats(chat_id) ON DELETE CASCADE,
      visible_index INTEGER,
      preview TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      PRIMARY KEY(run_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES whatsapp_chats(chat_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES whatsapp_import_runs(run_id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      timestamp_text TEXT,
      timestamp_iso TEXT,
      sender TEXT,
      text TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS whatsapp_message_fts
    USING fts5(message_id UNINDEXED, chat_id UNINDEXED, sender, text);

    CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_id_idx ON whatsapp_messages(chat_id);
    CREATE INDEX IF NOT EXISTS whatsapp_messages_timestamp_iso_idx ON whatsapp_messages(timestamp_iso);
    CREATE INDEX IF NOT EXISTS whatsapp_chats_title_idx ON whatsapp_chats(title);
  `);
}

function stableHash(parts: Array<string | number | null | undefined>) {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 32);
}

function canonicalYoutubeUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseWhatsappTimestamp(value: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, hour, minute, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:00`;
}

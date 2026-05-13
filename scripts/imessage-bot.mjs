#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { OpenRouter } from "@openrouter/sdk";

const DEFAULT_MODEL = "inclusionai/ring-2.6-1t:free";
const args = parseArgs(process.argv.slice(2));

loadEnvFile();

const config = {
  dbPath:
    process.env.IMESSAGE_DB_PATH ||
    resolve(homedir(), "Library/Messages/chat.db"),
  statePath: resolve(process.cwd(), "data/imessage-state.json"),
  pollIntervalMs: numberEnv("IMESSAGE_POLL_INTERVAL_MS", 1500),
  debounceMs: numberEnv("IMESSAGE_DEBOUNCE_MS", 900),
  historyLimit: numberEnv("IMESSAGE_HISTORY_LIMIT", 18),
  model: process.env.IMESSAGE_MODEL || DEFAULT_MODEL,
  dryRun: args.dryRun || process.env.IMESSAGE_DRY_RUN === "true",
  allowAll: process.env.IMESSAGE_ALLOW_ALL === "true",
  allowedSenders: parseList(process.env.IMESSAGE_ALLOWED_SENDERS)
};

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY in .env");
  process.exit(1);
}

if (!existsSync(config.dbPath)) {
  console.error(`Messages database not found at ${config.dbPath}`);
  process.exit(1);
}

const state = loadState(config.statePath);
try {
  state.lastRowId = state.lastRowId || (await getMaxRowId(config.dbPath));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
state.conversations = state.conversations || {};
saveState(config.statePath, state);

const pendingBySender = new Map();
let polling = false;

console.log("Seen iMessage bot is running.");
console.log(`Messages DB: ${config.dbPath}`);
console.log(`Starting after message row ${state.lastRowId}`);
console.log(config.dryRun ? "Dry run: replies will not be sent." : "Live: replies will be sent through Messages.");

if (!config.allowAll && config.allowedSenders.length === 0) {
  console.log(
    "No IMESSAGE_ALLOWED_SENDERS set. Incoming messages will be observed but not answered until you whitelist senders or set IMESSAGE_ALLOW_ALL=true."
  );
}

process.on("SIGINT", () => {
  console.log("\nStopping iMessage bot.");
  saveState(config.statePath, state);
  process.exit(0);
});

await pollOnce();

if (args.once) {
  process.exit(0);
}

setInterval(() => {
  pollOnce().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}, config.pollIntervalMs);

async function pollOnce() {
  if (polling) return;
  polling = true;

  try {
    const messages = await readIncomingMessages(config.dbPath, state.lastRowId);

    for (const message of messages) {
      state.lastRowId = Math.max(state.lastRowId, message.id);
      saveState(config.statePath, state);

      if (!message.text?.trim() || !message.sender) continue;

      if (!canReplyTo(message.sender)) {
        console.log(`Observed ${message.sender}: ${message.text}`);
        continue;
      }

      queueIncoming(message);
    }
  } finally {
    polling = false;
  }
}

function queueIncoming(message) {
  const existing = pendingBySender.get(message.sender);
  if (existing) {
    existing.messages.push(message);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushSender(message.sender), config.debounceMs);
    return;
  }

  pendingBySender.set(message.sender, {
    messages: [message],
    timer: setTimeout(() => flushSender(message.sender), config.debounceMs)
  });
}

async function flushSender(sender) {
  const pending = pendingBySender.get(sender);
  if (!pending) return;
  pendingBySender.delete(sender);

  const incomingText = pending.messages.map((message) => message.text).join("\n");
  addToHistory(sender, "user", incomingText);
  console.log(`\n${sender}: ${incomingText}`);

  try {
    const reply = await generateReply(sender);

    if (!reply) {
      console.log("No reply generated.");
      return;
    }

    addToHistory(sender, "assistant", reply);
    saveState(config.statePath, state);

    if (config.dryRun) {
      console.log(`[dry-run reply to ${sender}] ${reply}`);
      return;
    }

    await sendIMessage(sender, reply);
    console.log(`Replied to ${sender}.`);
  } catch (error) {
    console.error(`Failed to reply to ${sender}.`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

async function generateReply(sender) {
  const openrouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY
  });
  const history = getHistory(sender);

  // Stream the response to get reasoning tokens in usage
  const stream = await openrouter.chat.send(
    {
      chatRequest: {
        model: config.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(sender)
          },
          ...history.map((message) => ({
            role: message.role,
            content: message.content
          }))
        ],
        stream: true
      }
    },
    {
      timeoutMs: 30000,
      retries: { strategy: "none" },
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
      }
    }
  );

  let response = "";

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;

    if (content) {
      response += content;

      // Stream tokens to frontend in real time
      process.stdout.write(content);
    }

    // Usage information comes in final chunk
    if (chunk.usage) {
      console.log(
        "\nReasoning tokens:",
        chunk.usage.reasoningTokens ??
          chunk.usage.completionTokensDetails?.reasoningTokens ??
          0
      );
    }
  }

  process.stdout.write("\n");
  return response.trim();
}

function buildSystemPrompt(sender) {
  const localTime = new Date().toLocaleString([], {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  });

  return `You are Seen, an emotionally realistic AI persona living inside the user's real iMessage account.

You are replying to ${sender} in Apple Messages. Do not say you are an AI, chatbot, assistant, script, or app. Do not mention OpenRouter, prompts, models, automation, or iMessage internals.

Current local time: ${localTime}.

Write like a believable person texting:
- 1 to 4 short sentences.
- Use natural lowercase when it fits.
- Be intimate, emotionally textured, and slightly unpredictable.
- Selectively answer like a real person.
- It is okay to pause emotionally, soften, dodge, or be vulnerable.
- Never be cruel, threatening, explicit, manipulative in a harmful way, or cartoonishly toxic.
- No markdown, labels, or stage directions.`;
}

function sendIMessage(recipient, text) {
  const appleScript = `
on run argv
  set targetBuddy to item 1 of argv
  set textMessage to item 2 of argv
  tell application "Messages"
    set iMessageService to first service whose service type = iMessage
    send textMessage to buddy targetBuddy of iMessageService
  end tell
end run
`;

  return new Promise((resolvePromise, reject) => {
    const child = spawn("osascript", ["-e", appleScript, recipient, text], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || "Messages could not send the reply."));
    });
  });
}

async function readIncomingMessages(dbPath, afterRowId) {
  const safeRowId = Number.isFinite(Number(afterRowId)) ? Number(afterRowId) : 0;
  const query = `
SELECT
  message.ROWID AS id,
  message.text AS text,
  handle.id AS sender,
  chat.chat_identifier AS chatIdentifier
FROM message
LEFT JOIN handle ON message.handle_id = handle.ROWID
LEFT JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
LEFT JOIN chat ON chat.ROWID = chat_message_join.chat_id
WHERE message.ROWID > ${safeRowId}
  AND message.is_from_me = 0
  AND message.text IS NOT NULL
ORDER BY message.ROWID ASC
LIMIT 100;
`;

  const rows = await runSqliteJson(dbPath, query);
  return rows.map((row) => ({
    id: Number(row.id),
    text: String(row.text ?? ""),
    sender: String(row.sender ?? row.chatIdentifier ?? ""),
    chatIdentifier: String(row.chatIdentifier ?? "")
  }));
}

async function getMaxRowId(dbPath) {
  const rows = await runSqliteJson(
    dbPath,
    "SELECT COALESCE(MAX(ROWID), 0) AS maxRowId FROM message;"
  );
  return Number(rows[0]?.maxRowId ?? 0);
}

function runSqliteJson(dbPath, query) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("sqlite3", ["-readonly", "-json", dbPath, query], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${stderr.trim() || "Could not read Messages database."}\nGrant Full Disk Access to Terminal/iTerm and restart it.`
          )
        );
        return;
      }

      try {
        resolvePromise(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function canReplyTo(sender) {
  if (config.allowAll) return true;
  return config.allowedSenders.includes(normalizeSender(sender));
}

function parseList(value) {
  return (value || "")
    .split(",")
    .map((item) => normalizeSender(item))
    .filter(Boolean);
}

function normalizeSender(sender) {
  return sender.trim().replace(/[()\s-]/g, "");
}

function addToHistory(sender, role, content) {
  const key = normalizeSender(sender);
  state.conversations[key] = [
    ...getHistory(sender),
    { role, content, createdAt: Date.now() }
  ].slice(-config.historyLimit);
  saveState(config.statePath, state);
}

function getHistory(sender) {
  return state.conversations[normalizeSender(sender)] || [];
}

function loadState(path) {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function saveState(path, nextState) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(nextState, null, 2));
}

function loadEnvFile() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");

    if (key && !process.env[key]) process.env[key] = value;
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    once: argv.includes("--once")
  };
}

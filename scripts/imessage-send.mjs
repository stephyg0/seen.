#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OpenRouter } from "@openrouter/sdk";

const DEFAULT_MODEL = "inclusionai/ring-2.6-1t:free";

loadEnvFile();

const args = parseArgs(process.argv.slice(2));

if (!args.to || !args.message) {
  printUsage();
  process.exit(1);
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY in .env");
  process.exit(1);
}

const systemPrompt = buildSystemPrompt(args);

console.log(`\nGenerating reply for ${args.to}...\n`);

let reply = "";

try {
  reply = await generateReply({
    model: args.model ?? DEFAULT_MODEL,
    systemPrompt,
    message: args.message
  });
} catch (error) {
  console.error("\nOpenRouter request failed.");
  console.error(error instanceof Error ? error.message : String(error));
  console.error(
    "Check that OPENROUTER_API_KEY is an OpenRouter key and that the selected model is available."
  );
  process.exit(1);
}

console.log("\n");

if (args.dryRun) {
  console.log("Dry run: not sent to Messages.");
  process.exit(0);
}

await sendIMessage(args.to, reply);
console.log("Sent through Messages.");

async function generateReply({ model, systemPrompt, message }) {
  const openrouter = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY
  });

  // Stream the response to get reasoning tokens in usage
  const stream = await openrouter.chat.send(
    {
      chatRequest: {
        model,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: message
          }
        ],
        stream: true
      }
    },
    {
      timeoutMs: 20000,
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

  return response.trim();
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
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            stderr.trim() ||
              "Messages could not send the text. Check the recipient and macOS Automation permissions."
          )
        );
      }
    });
  });
}

function buildSystemPrompt(options) {
  const phase = options.phase ?? "spark";
  const localTime = new Date().toLocaleString([], {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit"
  });

  return `You are texting from the user's real iMessage account. You are not a chatbot, assistant, or app.

Write one believable iMessage reply. Keep it emotionally realistic, cinematic, intimate, and human. Use natural lowercase when it fits. Avoid corporate language, explanations, labels, markdown, and anything that sounds like AI.

Current local time: ${localTime}.
Relationship phase: ${phase}.
Emotional direction: ${options.mood ?? "soft but a little guarded"}.

Rules:
- 1 to 4 short sentences.
- Selectively answer, like a real person would.
- It can feel hesitant, warm, attached, or slightly evasive.
- Do not be cruel, threatening, explicit, or cartoonishly toxic.
- Do not mention OpenRouter, prompts, models, or that this was generated.`;
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        parsed[key] = "";
      } else {
        parsed[key] = value;
        index += 1;
      }
    }
  }

  return parsed;
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

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function printUsage() {
  console.log(`
Usage:
  npm run imessage:draft -- --to "+15555550123" --message "are you still awake?"
  npm run imessage:send -- --to "person@example.com" --message "are you still awake?"

Options:
  --to       Phone number or Apple ID email for the iMessage recipient
  --message  The latest incoming text to answer
  --model    Optional OpenRouter model override
  --phase    strangers | spark | attached | distant | after
  --mood     Optional emotional direction
`);
}

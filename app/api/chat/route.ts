import { OpenRouter } from "@openrouter/sdk";
import {
  DEFAULT_MODEL,
  buildSystemPrompt,
  messagesForModel
} from "@/lib/emotion-engine";
import type { ChatMessage, EmotionalState, SettingsState } from "@/lib/chat-types";

export const runtime = "nodejs";

type ChatRequest = {
  messages: ChatMessage[];
  settings: SettingsState;
  emotion: EmotionalState;
  localTime: string;
};

type OpenRouterChunk = {
  choices: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    reasoningTokens?: number | null;
    completionTokensDetails?: { reasoningTokens?: number | null } | null;
  };
};

const OPENROUTER_RETRY_DELAYS_MS = [0, 900, 1900];
const UNAVAILABLE_REPLY =
  "my phone is being weird give me a minute";
const CREDIT_EXHAUSTED_REPLY =
  "i cant text right now";

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequest;
  const systemPrompt = buildSystemPrompt(
    body.emotion,
    body.settings,
    body.localTime
  );
  const messages = messagesForModel(body.messages);

  try {
    if (!process.env.OPENROUTER_API_KEY) {
      console.error("OpenRouter API key missing. Set OPENROUTER_API_KEY in local and deployed environments.");
      return textResponse(UNAVAILABLE_REPLY, 503);
    }

    const openrouter = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY
    });

    const requestMessages = [
      {
        role: "system",
        content: systemPrompt
      },
      ...messages
    ];
    let response = await generateOpenRouterReplyWithRetry(
      openrouter,
      requestMessages
    );

    if (isTooSimilarToRecent(response, body.messages)) {
      response = await generateOpenRouterReplyWithRetry(
        openrouter,
        [
          ...requestMessages,
          {
            role: "system",
            content:
              "That reply was too repetitive. Write a different toxic ex reply with a new angle. Keep it short and natural."
          }
        ]
      );
    }

    if (!response.trim()) {
      console.error("OpenRouter returned empty responses after retries.");
      return textResponse(UNAVAILABLE_REPLY, 503);
    }

    return textResponse(response);
  } catch (error) {
    console.error(error);
    if (isCreditOrQuotaError(error)) {
      return textResponse(CREDIT_EXHAUSTED_REPLY, 402);
    }

    return textResponse(UNAVAILABLE_REPLY, 503);
  }
}

function stripEmoji(text: string) {
  return text.replace(/\p{Extended_Pictographic}/gu, "");
}

function cleanTextingStyle(text: string) {
  return stripEmoji(text)
    .replace(/[\\\/]+(?=\s|$)/g, "")
    .replace(/[\\\/]+/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[!。]/g, "")
    .replace(/([^\s.?!…-])[.](?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

function textResponse(text: string, status = 200) {
  return new Response(cleanTextingStyle(text), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

function streamSafeText(text: string) {
  return stripEmoji(text)
    .replace(/[\\\/]+(?=\s|$)/g, "")
    .replace(/[\\\/]+/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[!。]/g, "")
    .replace(/([^\s.?!…-])[.](?=\s|$)/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

async function streamOpenRouterReply(
  openrouter: OpenRouter,
  messages: Array<{ role: string; content: string }>
) {
  // Stream the response to get reasoning tokens in usage
  const stream = (await openrouter.chat.send(
    {
      chatRequest: {
        model: DEFAULT_MODEL,
        messages,
        stream: true,
        maxCompletionTokens: 220,
        temperature: 1.08,
        presencePenalty: 0.9,
        frequencyPenalty: 0.85
      }
    } as any,
    {
      timeoutMs: 20000,
      retries: { strategy: "none" },
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`
      }
    }
  )) as unknown as AsyncIterable<OpenRouterChunk>;

  let response = "";

  for await (const chunk of stream) {
    const content = streamSafeText(chunk.choices[0]?.delta?.content ?? "");

    if (content) {
      response += content;

      process.stdout.write(content);
    }

    // Usage information comes in final chunk
    if (chunk.usage) {
      const reasoningTokens =
        chunk.usage.reasoningTokens ??
        chunk.usage.completionTokensDetails?.reasoningTokens ??
        0;
      console.log("\nReasoning tokens:", reasoningTokens);
    }
  }

  return response;
}

async function generateOpenRouterReplyWithRetry(
  openrouter: OpenRouter,
  messages: Array<{ role: string; content: string }>
) {
  let lastError: unknown = null;

  for (const [attemptIndex, delayMs] of OPENROUTER_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) await delay(delayMs);

    try {
      const response = await streamOpenRouterReply(openrouter, messages);
      if (response.trim()) return response;
      console.warn(`OpenRouter returned empty response on attempt ${attemptIndex + 1}.`);
    } catch (error) {
      lastError = error;
      console.error(`OpenRouter attempt ${attemptIndex + 1} failed.`, error);
      if (isCreditOrQuotaError(error)) throw error;
    }
  }

  if (lastError) throw lastError;
  return "";
}

function isTooSimilarToRecent(response: string, messages: ChatMessage[]) {
  const normalizedResponse = normalizeForSimilarity(response);
  if (normalizedResponse.length < 5) return false;

  return messages
    .filter((message) => message.role === "assistant")
    .slice(-6)
    .some((message) => {
      const normalizedMessage = normalizeForSimilarity(message.content);
      return (
        normalizedMessage === normalizedResponse ||
        normalizedMessage.includes(normalizedResponse) ||
        normalizedResponse.includes(normalizedMessage)
      );
    });
}

function normalizeForSimilarity(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isCreditOrQuotaError(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();

  return (
    lower.includes("rate limit exceeded") ||
    lower.includes("free-models-per-day") ||
    lower.includes("requires more credits") ||
    lower.includes("paymentrequired") ||
    lower.includes("insufficient credits")
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

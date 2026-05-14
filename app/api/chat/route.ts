import { OpenRouter } from "@openrouter/sdk";
import {
  DEFAULT_MODEL,
  buildSystemPrompt,
  fallbackReply,
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

const encoder = new TextEncoder();

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequest;
  const systemPrompt = buildSystemPrompt(
    body.emotion,
    body.settings,
    body.localTime
  );
  const messages = messagesForModel(body.messages);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        if (!process.env.OPENROUTER_API_KEY) {
          await writeWithPacing(
            controller,
            fallbackReply(body.emotion, body.messages)
          );
          controller.close();
          return;
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
        let response = await streamOpenRouterReply(
          openrouter,
          requestMessages
        );

        if (isTooSimilarToRecent(response, body.messages)) {
          response = await streamOpenRouterReply(
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
          await writeWithPacing(
            controller,
            fallbackReply(body.emotion, body.messages)
          );
        } else {
          await writeWithPacing(controller, response);
        }

        controller.close();
      } catch (error) {
        console.error(error);
        await writeWithPacing(
          controller,
          fallbackReply(body.emotion, body.messages)
        );
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

async function writeWithPacing(
  controller: ReadableStreamDefaultController<Uint8Array>,
  text: string
) {
  const cleanText = cleanTextingStyle(text);
  for (const piece of cleanText.match(/.{1,5}/g) ?? [cleanText]) {
    controller.enqueue(encoder.encode(piece));
    await new Promise((resolve) => setTimeout(resolve, 45));
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

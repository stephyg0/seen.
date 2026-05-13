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

        // Stream the response to get reasoning tokens in usage
        const stream = (await openrouter.chat.send(
          {
            chatRequest: {
              model: DEFAULT_MODEL,
              messages: [
                {
                  role: "system",
                  content: systemPrompt
                },
                ...messages
              ],
              stream: true,
              maxCompletionTokens: 220,
              temperature: 0.95,
              presencePenalty: 0.6,
              frequencyPenalty: 0.45
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
          const content = cleanTextingStyle(chunk.choices[0]?.delta?.content ?? "");

          if (content) {
            response += content;

            // Stream tokens to frontend in real time
            process.stdout.write(content);
            controller.enqueue(encoder.encode(content));
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

        if (!response.trim()) {
          await writeWithPacing(
            controller,
            fallbackReply(body.emotion, body.messages)
          );
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
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[!。]/g, "")
    .replace(/([^\s.?!…-])[.](?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

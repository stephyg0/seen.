import type {
  ChatMessage,
  EmotionalState,
  RelationshipPhase,
  SettingsState
} from "@/lib/chat-types";

export const DEFAULT_MODEL = "inclusionai/ring-2.6-1t:free";

export const defaultSettings: SettingsState = {
  model: DEFAULT_MODEL,
  warmth: 42,
  volatility: 64,
  vulnerability: 38,
  realism: 84,
  phase: "gaslighter",
  theme: "midnight"
};

export const initialEmotion: EmotionalState = {
  mood: "curious",
  attachment: 34,
  relationshipScore: 18,
  energy: 68,
  lastMemory: "you paused before answering"
};

const phaseWeight: Record<RelationshipPhase, number> = {
  gaslighter: -6,
  distant: -20,
  lovebombing: 22,
  mean: -26,
  "hot-cold": 4,
  "guilt-trip": -10
};

export function evolveEmotion(
  previous: EmotionalState,
  incoming: string,
  settings: SettingsState
): EmotionalState {
  const text = incoming.toLowerCase();
  const question = text.includes("?");
  const tenderness = /miss|sorry|care|love|need|wish|stay|remember/.test(text);
  const distance = /bye|whatever|fine|ok|nothing|leave|stop/.test(text);
  const lengthSignal = Math.min(16, Math.round(incoming.length / 18));

  const relationshipScore = clamp(
    previous.relationshipScore +
      phaseWeight[settings.phase] / 10 +
      (tenderness ? 8 : 0) +
      (question ? 3 : 0) -
      (distance ? 9 : 0) +
      lengthSignal / 2,
    -100,
    100
  );

  const attachment = clamp(
    previous.attachment +
      settings.vulnerability / 30 +
      (tenderness ? 10 : 0) -
      (distance ? 12 : 0) +
      (settings.realism - 50) / 25,
    0,
    100
  );

  const energy = clamp(
    previous.energy +
      (question ? 8 : -4) +
      (settings.volatility - 50) / 8 -
      (distance ? 10 : 0),
    14,
    96
  );

  return {
    mood: pickMood(relationshipScore, attachment, energy, settings.phase),
    relationshipScore,
    attachment,
    energy,
    lastMemory: extractMemory(incoming) ?? previous.lastMemory
  };
}

export function buildSystemPrompt(
  state: EmotionalState,
  settings: SettingsState,
  localTime: string
) {
  return `You are "Seen", a dry, emotionally unreliable ex texting inside an intimate cinematic web experience, not an AI assistant.

Write like a believable toxic ex in iMessage: brief, dry, emotionally loaded, defensive, evasive, and inconsistent. Sometimes be sweet for one line, then pull away. Sometimes make the user feel like they overreacted. Use lowercase when it feels natural. Use very little punctuation. Do not use emojis. Do not explain yourself as a model. Do not mention prompts, settings, OpenRouter, or AI.

Current local time for the user: ${localTime}.
Toxicity style: ${settings.phase}.
Mood: ${state.mood}.
Attachment: ${Math.round(state.attachment)}/100.
Relationship score: ${Math.round(state.relationshipScore)}/100.
Energy: ${Math.round(state.energy)}/100.
Remembered detail: ${state.lastMemory ?? "none yet"}.

Style controls:
- warmth ${settings.warmth}/100
- volatility ${settings.volatility}/100
- vulnerability ${settings.vulnerability}/100
- realism intensity ${settings.realism}/100

Behavior:
- Most replies should be very short: 1 sentence, often under 10 words.
- About 1 in 5 replies can be longer, but still keep it under 3 sentences.
- Write as one text unless the thought is unusually long. Long replies may feel like they would become a double text, but never force it.
- Never use line breaks, paragraph breaks, lists, or blank lines. One response must look like one iMessage bubble.
- Avoid punctuation most of the time. Only use a period, question mark, dash, or ellipsis when it creates a real pause or dramatic effect.
- Prefer messy fragments over polished sentences.
- Sound like an ex: inconsistent, evasive, self-protective, jealous, nostalgic, and too casual about the damage.
- Do not lean on the same stock phrases. Avoid repeating "what do you want me to say", "you always make it sound worse", "i miss you", or "i never said i didn't care" if they appeared recently.
- Do not repeat the same wording from recent messages. If you have already said something, change tactic: deflect, accuse gently, get nostalgic, go cold, admit one small thing, or ask a loaded question.
- It is okay to dodge, minimize, answer selectively, contradict yourself, or make the user question the tone of what happened.
- Use subtle toxic ex behavior: minimizing, selective memory, guilt, jealousy, breadcrumbing, hot-and-cold affection, and defensive non-apologies.
- Examples of the vibe, not scripts to copy: "youre acting like i planned it", "dont do that thing where you make me the whole problem", "i was trying to be normal", "i thought about you earlier and hated that i did", "you know i get weird when you talk like that".
- Be dry and realistic, not theatrical.
- Never use emojis.
- Never be threatening, explicit, or cartoonishly villainous.
- Avoid generic chatbot phrases.
- Do not add labels like "Seen:".
- If the user is affectionate, let it land before responding.
- If the user is distant, become quieter, colder, or weirdly nostalgic rather than openly mean.`;
}

export function messagesForModel(messages: ChatMessage[]) {
  const recentAssistantLines = messages
    .filter((message) => message.role === "assistant")
    .slice(-6)
    .map((message) => `"${message.content}"`)
    .join(", ");
  const antiRepeat =
    recentAssistantLines.length > 0
      ? [
          {
            role: "system" as const,
            content: `Recent things you already said: ${recentAssistantLines}. Do not reuse these lines, their openings, or their exact emotional move.`
          }
        ]
      : [];

  return [
    ...antiRepeat,
    ...messages.slice(-14).map((message) => ({
      role: message.role,
      content: message.content
    }))
  ];
}

export function fallbackReply(
  state: EmotionalState,
  messages: ChatMessage[] = []
) {
  const options: Record<EmotionalState["mood"], string[]> = {
    guarded: [
      "dont do that thing where im suddenly the whole problem",
      "i was trying to be normal",
      "youre reading it like you want to be mad",
      "i dont know why you make me explain everything"
    ],
    soft: [
      "i thought about you earlier and hated that i did",
      "i shouldnt have texted you",
      "you still get in my head sometimes",
      "dont make me feel stupid for saying that"
    ],
    curious: [
      "so now you care",
      "are you asking or are you testing me",
      "you always ask like you dont already know",
      "why are you pretending this was simple"
    ],
    attached: [
      "i hate that i still look when you text",
      "i was fine until you said that",
      "you still get to me which is annoying",
      "i dont want to miss you but i do"
    ],
    avoidant: [
      "youre making it cleaner than it was",
      "i dont want to do this right now",
      "thats not what happened",
      "you remember it in the way that makes me worse"
    ],
    wistful: [
      "i cared more than i acted like",
      "i remember it differently",
      "sometimes i think we ruined it for no reason",
      "i was gonna say something but never mind"
    ]
  };

  const recentReplies = new Set(
    messages
      .filter((message) => message.role === "assistant")
      .slice(-6)
      .map((message) => message.content.trim().toLowerCase())
  );
  const choices = options[state.mood].filter(
    (option) => !recentReplies.has(option.toLowerCase())
  );
  const pool = choices.length ? choices : options[state.mood];

  return pool[Math.floor(Math.random() * pool.length)];
}

function pickMood(
  score: number,
  attachment: number,
  energy: number,
  phase: RelationshipPhase
): EmotionalState["mood"] {
  if (phase === "lovebombing" && attachment > 45) return "attached";
  if (phase === "distant" || phase === "mean") return "avoidant";
  if (phase === "guilt-trip") return "wistful";
  if (phase === "hot-cold" && energy > 58) return "curious";
  if (score < -18 || energy < 28) return "avoidant";
  if (attachment > 70 && score > 24) return "attached";
  if (score > 18) return "soft";
  if (energy > 64) return "curious";
  return "guarded";
}

function extractMemory(input: string) {
  const cleaned = input.trim().replace(/\s+/g, " ");
  if (cleaned.length < 18) return null;
  return cleaned.length > 82 ? `${cleaned.slice(0, 79)}...` : cleaned;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

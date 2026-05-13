export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: Exclude<ChatRole, "system">;
  content: string;
  createdAt: number;
  status?: "sending" | "delivered" | "read";
  meta?: string;
};

export type RelationshipPhase =
  | "gaslighter"
  | "distant"
  | "lovebombing"
  | "mean"
  | "hot-cold"
  | "guilt-trip";

export type ThemeName = "midnight" | "paper" | "blood-orange" | "blue-hour";

export type SettingsState = {
  model: string;
  warmth: number;
  volatility: number;
  vulnerability: number;
  realism: number;
  phase: RelationshipPhase;
  theme: ThemeName;
};

export type EmotionalState = {
  mood:
    | "guarded"
    | "soft"
    | "curious"
    | "attached"
    | "avoidant"
    | "wistful";
  attachment: number;
  relationshipScore: number;
  lastMemory?: string;
  energy: number;
};

"use client";

import {
  ArrowLeft,
  Bell,
  ChevronDown,
  Info,
  Palette,
  Send,
  Signal,
  SlidersHorizontal,
  Wifi
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ChatMessage,
  EmotionalState,
  RelationshipPhase,
  SettingsState,
  ThemeName
} from "@/lib/chat-types";
import {
  defaultSettings,
  evolveEmotion,
  initialEmotion
} from "@/lib/emotion-engine";

const phaseOptions: RelationshipPhase[] = [
  "gaslighter",
  "distant",
  "lovebombing",
  "mean",
  "hot-cold",
  "guilt-trip"
];

const themeOptions: ThemeName[] = [
  "midnight",
  "paper",
  "blood-orange",
  "blue-hour"
];

const openingMessages: ChatMessage[] = [
  {
    id: "opening-1",
    role: "assistant",
    content: "you up?",
    createdAt: Date.now() - 1000 * 60 * 7,
    status: "read",
    meta: "2 min ago"
  }
];

const QUOTA_FALLBACK_LIMIT = 2;

const quotaExitMessages = [
  "yk nvm im busy we can talk later",
  "i cant text rn",
  "never mind i have to go",
  "i shouldnt be doing this rn"
];

export function TextingExperience() {
  const [started, setStarted] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [emotion, setEmotion] = useState<EmotionalState>(initialEmotion);
  const [messages, setMessages] = useState<ChatMessage[]>(openingMessages);
  const [contactName, setContactName] = useState("seen");
  const [setupName, setSetupName] = useState("seen");
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState<"idle" | "thinking" | "typing">("idle");
  const [interrupted, setInterrupted] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [, setUnreadCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<ChatMessage[]>(openingMessages);
  const settingsRef = useRef<SettingsState>(defaultSettings);
  const emotionRef = useRef<EmotionalState>(initialEmotion);
  const contactNameRef = useRef(contactName);
  const replyTimerRef = useRef<number | null>(null);
  const replyInFlightRef = useRef(false);
  const pendingReplyRef = useRef(false);
  const lastHandledUserIdRef = useRef<string | null>(null);
  const quotaFallbackCountRef = useRef(0);
  const quotaGhostUntilRef = useRef(0);

  useEffect(() => {
    setNotificationPermission(
      "Notification" in window ? Notification.permission : "unsupported"
    );

    const saved = window.localStorage.getItem("seen-settings");
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<SettingsState>;
      const next = { ...defaultSettings, ...parsed };
      if (!phaseOptions.includes(next.phase)) next.phase = defaultSettings.phase;
      setSettings(next);
    }

    const savedProfile = window.localStorage.getItem("seen-profile");
    if (savedProfile) {
      const profile = JSON.parse(savedProfile) as { contactName?: string };
      if (profile.contactName) {
        setContactName(profile.contactName);
        setSetupName(profile.contactName);
      }
    }

    const savedQuotaFallbackCount = Number(
      window.localStorage.getItem("seen-quota-fallback-count") ?? "0"
    );
    const savedQuotaGhostUntil = Number(
      window.localStorage.getItem("seen-quota-ghost-until") ?? "0"
    );

    if (savedQuotaGhostUntil > Date.now()) {
      quotaFallbackCountRef.current = Number.isFinite(savedQuotaFallbackCount)
        ? savedQuotaFallbackCount
        : 0;
      quotaGhostUntilRef.current = savedQuotaGhostUntil;
    } else {
      clearQuotaFallbackState();
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("seen-settings", JSON.stringify(settings));
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem("seen-profile", JSON.stringify({ contactName }));
    contactNameRef.current = contactName;
  }, [contactName]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    emotionRef.current = emotion;
  }, [emotion]);

  useEffect(() => {
    const resetUnread = () => {
      if (!document.hidden && document.hasFocus()) {
        setUnreadCount(0);
        document.title = "seen";
      }
    };

    document.addEventListener("visibilitychange", resetUnread);
    window.addEventListener("focus", resetUnread);

    return () => {
      document.removeEventListener("visibilitychange", resetUnread);
      window.removeEventListener("focus", resetUnread);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages, typing, interrupted]);

  const themeClass = `theme-${settings.theme}`;

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = input.trim();
    if (!content) return;
    void requestAndStoreNotifications();

    const now = Date.now();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: now,
      status: "sending",
      meta: "Sending"
    };

    const nextEmotion = evolveEmotion(
      emotionRef.current,
      content,
      settingsRef.current
    );
    setMessages((current) => {
      const next = [...current, userMessage];
      messagesRef.current = next;
      return next;
    });
    setEmotion(nextEmotion);
    setInput("");

    window.setTimeout(() => {
      setMessages((current) =>
        current.map((message) =>
          message.id === userMessage.id
            ? {
                ...message,
                status: "read",
                meta: `Read ${formatTime(new Date())}`
              }
            : message
        )
      );
    }, 700 + Math.random() * 900);

    requestReplySoon();
  }

  function requestReplySoon() {
    pendingReplyRef.current = true;

    if (replyTimerRef.current) {
      window.clearTimeout(replyTimerRef.current);
    }

    replyTimerRef.current = window.setTimeout(() => {
      void processReplyQueue();
    }, 900 + Math.random() * 1300);
  }

  async function processReplyQueue() {
    if (replyInFlightRef.current) return;

    const latestUserMessage = [...messagesRef.current]
      .reverse()
      .find((message) => message.role === "user");

    if (!latestUserMessage || latestUserMessage.id === lastHandledUserIdRef.current) {
      pendingReplyRef.current = false;
      return;
    }

    pendingReplyRef.current = false;
    replyInFlightRef.current = true;
    setIsSending(true);

    const snapshotMessages = messagesRef.current;
    const snapshotSettings = settingsRef.current;
    const snapshotEmotion = emotionRef.current;
    const userMessageCount = snapshotMessages.filter(
      (message) => message.role === "user"
    ).length;
    const shouldLeaveOnRead =
      userMessageCount > 2 &&
      snapshotSettings.realism > 48 &&
      Math.random() < 0.035 + snapshotSettings.volatility / 1200;

    await pause(900 + Math.random() * 1900);

    if (isQuotaGhosting()) {
      lastHandledUserIdRef.current = latestUserMessage.id;
      setTyping("idle");
      setIsSending(false);
      replyInFlightRef.current = false;
      inputRef.current?.focus();
      if (pendingReplyRef.current) requestReplySoon();
      return;
    }

    if (shouldLeaveOnRead) {
      lastHandledUserIdRef.current = latestUserMessage.id;
      setTyping("idle");
      setIsSending(false);
      replyInFlightRef.current = false;
      inputRef.current?.focus();
      if (pendingReplyRef.current) requestReplySoon();
      return;
    }

    await pause(240 + Math.random() * 700);
    setTyping("thinking");

    if (
      snapshotSettings.realism > 70 &&
      Math.random() < snapshotSettings.realism / 180
    ) {
      await pause(900 + Math.random() * 1400);
      setInterrupted(true);
      setTyping("idle");
      await pause(550 + Math.random() * 1200);
      setInterrupted(false);
      setTyping("thinking");
    }

    await pause(800 + Math.random() * 1800);
    setTyping("typing");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: snapshotMessages,
          settings: snapshotSettings,
          emotion: snapshotEmotion,
          localTime: new Date().toLocaleString([], {
            weekday: "long",
            hour: "numeric",
            minute: "2-digit"
          })
        })
      });

      if (!response.ok) {
        const errorText = normalizeAssistantText(await response.text());
        setTyping("idle");

        if (response.status === 402 && errorText) {
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: errorText,
              createdAt: Date.now()
            }
          ]);
          notifyIfAway(errorText);
        }

        return;
      }

      const fallbackReason = response.headers.get("X-Seen-Fallback");
      if (!response.body) throw new Error("No stream returned");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let responseText = "";

      while (!done) {
        const result = await reader.read();
        done = result.done;
        const chunk = decoder.decode(result.value ?? new Uint8Array(), {
          stream: !done
        });

        if (chunk) {
          responseText += chunk;
        }
      }

      setTyping("idle");
      const cleanReply = normalizeAssistantText(responseText);
      const finalReply = resolveQuotaFallbackReply(cleanReply, fallbackReason);
      if (!finalReply) return;
      await pause(Math.min(900, 160 + finalReply.length * 12));
      const replyParts = splitAssistantReply(finalReply);

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: replyParts[0],
          createdAt: Date.now()
        }
      ]);
      notifyIfAway(replyParts[0]);

      if (replyParts[1]) {
        await pause(700 + Math.random() * 1300);
        setTyping("typing");
        await pause(850 + Math.random() * 1500);
        setTyping("idle");
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: replyParts[1],
            createdAt: Date.now()
          }
        ]);
        notifyIfAway(replyParts[1]);
      }
    } catch (error) {
      console.error(error);
      setTyping("idle");
    } finally {
      lastHandledUserIdRef.current = latestUserMessage.id;
      setTyping("idle");
      setIsSending(false);
      replyInFlightRef.current = false;
      inputRef.current?.focus();
      if (pendingReplyRef.current) requestReplySoon();
    }
  }

  function notifyIfAway(message: string) {
    if (!shouldNotifyAway()) return;

    setUnreadCount((count) => {
      const nextCount = count + 1;
      document.title = `(${nextCount}) ${contactNameRef.current}`;
      return nextCount;
    });

    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const notification = new Notification(contactNameRef.current, {
      body: message,
      icon: "/profile_default.png",
      badge: "/profile_default.png",
      tag: `seen-${Date.now()}`
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      setUnreadCount(0);
      document.title = "seen";
      inputRef.current?.focus();
    };
  }

  async function requestAndStoreNotifications() {
    const permission = await requestNotificationPermission();
    setNotificationPermission(permission);
    return permission;
  }

  function resolveQuotaFallbackReply(reply: string, fallbackReason: string | null) {
    if (fallbackReason !== "quota") {
      clearQuotaFallbackState();
      return reply;
    }

    if (quotaFallbackCountRef.current >= QUOTA_FALLBACK_LIMIT) {
      const exitMessage = pickQuotaExitMessage();
      const ghostUntil = nextUtcMidnight();
      quotaGhostUntilRef.current = ghostUntil;
      window.localStorage.setItem("seen-quota-ghost-until", String(ghostUntil));
      window.localStorage.setItem(
        "seen-quota-fallback-count",
        String(quotaFallbackCountRef.current)
      );
      return exitMessage;
    }

    quotaFallbackCountRef.current += 1;
    window.localStorage.setItem(
      "seen-quota-fallback-count",
      String(quotaFallbackCountRef.current)
    );

    return reply;
  }

  function isQuotaGhosting() {
    if (quotaGhostUntilRef.current <= Date.now()) {
      clearQuotaFallbackState();
      return false;
    }

    return true;
  }

  function clearQuotaFallbackState() {
    quotaFallbackCountRef.current = 0;
    quotaGhostUntilRef.current = 0;
    window.localStorage.removeItem("seen-quota-fallback-count");
    window.localStorage.removeItem("seen-quota-ghost-until");
  }

  return (
    <main className={`experience ${themeClass}`}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      {!started ? (
        <Landing onStart={() => setSetupOpen(true)} />
      ) : (
        <section className="phone-shell" aria-label="Seen conversation">
          <StatusBar />
          <header className="chat-header">
            <button
              className="icon-button"
              type="button"
              aria-label="Back"
              onClick={() => setStarted(false)}
            >
              <ArrowLeft size={20} />
            </button>
            <div className="contact">
                <div className="avatar" aria-hidden="true" />
                <div>
                <div className="contact-name">{contactName}</div>
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Open settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Info size={20} />
            </button>
          </header>

          <div className="thread" ref={scrollRef}>
            <div className="day-stamp">Today {formatTime(new Date())}</div>
            {messages.map((message, index) => (
              <MessageBubble
                key={message.id}
                message={message}
                previous={messages[index - 1]}
                showReceipt={isLastReadUserMessage(messages, index)}
              />
            ))}
            {typing !== "idle" ? <TypingIndicator /> : null}
          </div>

          <form className="composer" onSubmit={sendMessage}>
            <button
              className="mini-button"
              type="button"
              aria-label="Mood settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SlidersHorizontal size={18} />
            </button>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="iMessage"
              aria-label="Message"
              autoComplete="off"
            />
            <button
              className="send-button"
              type="submit"
              aria-label="Send message"
              disabled={!input.trim()}
            >
              <Send size={17} />
            </button>
          </form>

        </section>
      )}

      <SetupSheet
        open={setupOpen}
        name={setupName}
        onNameChange={setSetupName}
        onClose={() => setSetupOpen(false)}
        onStart={() => {
          const nextName = setupName.trim() || "seen";
          setContactName(nextName);
          setSetupName(nextName);
          contactNameRef.current = nextName;
          void requestAndStoreNotifications();
          setSetupOpen(false);
          setStarted(true);
        }}
      />

      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        notificationPermission={notificationPermission}
        onClose={() => setSettingsOpen(false)}
        onChange={setSettings}
        onEnableNotifications={requestAndStoreNotifications}
      />
    </main>
  );
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;

  try {
    return await Notification.requestPermission();
  } catch {
    // Browsers can reject permission prompts outside their preferred gesture path.
    return Notification.permission;
  }
}

function shouldNotifyAway() {
  return typeof document !== "undefined" && (document.hidden || !document.hasFocus());
}

function notificationLabel(permission: NotificationPermission | "unsupported") {
  if (permission === "granted") return "on";
  if (permission === "denied") return "blocked in browser settings";
  if (permission === "unsupported") return "not supported here";
  return "allow notifications";
}

function pickQuotaExitMessage() {
  return quotaExitMessages[Math.floor(Math.random() * quotaExitMessages.length)];
}

function nextUtcMidnight() {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  return (
    <section className="landing">
      <div className="landing-copy">
        <img className="mark-logo" src="/seen-logo.svg" alt="seen" />
        <h1>the text you probably shouldn't answer.</h1>
        <p>
          A private little conversation that remembers too much and replies a
          beat too late.
        </p>
        <div className="landing-actions">
          <button className="start-button" type="button" onClick={onStart}>
            start texting
          </button>
        </div>
      </div>
      <div className="preview-card" aria-hidden="true">
        <StatusBar />
        <div className="preview-header">
          <ChevronDown size={18} />
          <span>seen</span>
          <Bell size={16} />
        </div>
        <div className="preview-thread">
          <div className="preview-date">now</div>
          <div className="preview-bubble">i almost didn't send this</div>
          <div className="preview-bubble second">but then you went quiet</div>
          <div className="preview-typing">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusBar() {
  return (
    <div className="status-bar" aria-hidden="true">
      <span>{formatTime(new Date())}</span>
      <div>
        <Signal size={14} />
        <Wifi size={14} />
        <span className="battery" />
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  previous,
  showReceipt
}: {
  message: ChatMessage;
  previous?: ChatMessage;
  showReceipt?: boolean;
}) {
  const grouped = previous?.role === message.role;
  return (
    <article
      className={`message-row ${message.role} ${grouped ? "grouped" : ""}`}
      style={{ "--delay": `${Math.random() * 120}ms` } as CSSProperties}
    >
      <div className="bubble">{message.content}</div>
      {showReceipt && message.meta ? (
        <div className="message-status">{message.meta}</div>
      ) : null}
    </article>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-wrap">
      <div className="typing">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function splitAssistantReply(text: string) {
  const clean = normalizeAssistantText(text);
  if (clean.length < 115 || Math.random() > 0.72) return [clean];

  const midpoint = Math.floor(clean.length / 2);
  const splitAt =
    findSplitPoint(clean, midpoint, ". ") ??
    findSplitPoint(clean, midpoint, "? ") ??
    findSplitPoint(clean, midpoint, " but ") ??
    findSplitPoint(clean, midpoint, " and ") ??
    findSplitPoint(clean, midpoint, " ");

  if (!splitAt || splitAt < 42 || clean.length - splitAt < 28) return [clean];

  return [
    clean.slice(0, splitAt).trim(),
    clean.slice(splitAt).trim()
  ];
}

function normalizeAssistantText(text: string) {
  return text
    .replace(/[\\\/]+(?=\s|$)/g, "")
    .replace(/[\\\/]+/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findSplitPoint(text: string, midpoint: number, token: string) {
  const before = text.lastIndexOf(token, midpoint);
  const after = text.indexOf(token, midpoint);
  const candidates = [before, after]
    .filter((index) => index > -1)
    .map((index) => index + token.length);

  if (!candidates.length) return null;

  return candidates.sort(
    (left, right) => Math.abs(left - midpoint) - Math.abs(right - midpoint)
  )[0];
}

function SetupSheet({
  open,
  name,
  onNameChange,
  onClose,
  onStart
}: {
  open: boolean;
  name: string;
  onNameChange: (name: string) => void;
  onClose: () => void;
  onStart: () => void;
}) {
  return (
    <aside className={`setup-sheet ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="sheet-handle" />
      <div className="setup-copy">
        <span>set the contact</span>
        <h2>who keeps texting?</h2>
      </div>
      <label className="setup-field">
        <span>display name</span>
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="seen"
          maxLength={24}
        />
      </label>
      <div className="setup-preview">
        <div className="avatar" aria-hidden="true" />
        <div>
          <strong>{name.trim() || "seen"}</strong>
        </div>
      </div>
      <div className="setup-actions">
        <button className="ghost-button" type="button" onClick={onClose}>
          cancel
        </button>
        <button className="start-button" type="button" onClick={onStart}>
          start texting
        </button>
      </div>
    </aside>
  );
}

function SettingsSheet({
  open,
  settings,
  notificationPermission,
  onClose,
  onChange,
  onEnableNotifications
}: {
  open: boolean;
  settings: SettingsState;
  notificationPermission: NotificationPermission | "unsupported";
  onClose: () => void;
  onChange: (settings: SettingsState) => void;
  onEnableNotifications: () => void;
}) {
  return (
    <aside className={`settings-sheet ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="sheet-handle" />
      <div className="sheet-title">
        <button className="icon-button" type="button" onClick={onClose}>
          <ChevronDown size={20} />
        </button>
      </div>

      <label className="field">
        <span>
          <Palette size={15} /> theme
        </span>
        <select
          value={settings.theme}
          onChange={(event) =>
            onChange({ ...settings, theme: event.target.value as ThemeName })
          }
        >
          {themeOptions.map((theme) => (
            <option key={theme} value={theme}>
              {theme}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span>
          <Bell size={15} /> notifications
        </span>
        <button
          className="field-button"
          type="button"
          onClick={onEnableNotifications}
          disabled={notificationPermission === "unsupported"}
        >
          {notificationLabel(notificationPermission)}
        </button>
      </div>

      <Slider
        label="warmth"
        value={settings.warmth}
        onChange={(warmth) => onChange({ ...settings, warmth })}
      />
      <Slider
        label="volatility"
        value={settings.volatility}
        onChange={(volatility) => onChange({ ...settings, volatility })}
      />
      <Slider
        label="vulnerability"
        value={settings.vulnerability}
        onChange={(vulnerability) => onChange({ ...settings, vulnerability })}
      />
      <Slider
        label="realism intensity"
        value={settings.realism}
        onChange={(realism) => onChange({ ...settings, realism })}
      />
    </aside>
  );
}

function Slider({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider">
      <span>
        {label}
        <b>{value}</b>
      </span>
      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function pacingFor(chunk: string, settings: SettingsState) {
  const punctuation = /[,.!?]/.test(chunk) ? 90 : 0;
  const realism = settings.realism * 1.2;
  return Math.min(420, 24 + chunk.length * 18 + punctuation + realism);
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function pause(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLastReadUserMessage(messages: ChatMessage[], index: number) {
  const message = messages[index];
  if (message.role !== "user" || message.status !== "read") return false;

  return !messages
    .slice(index + 1)
    .some((nextMessage) => nextMessage.role === "user" && nextMessage.status === "read");
}

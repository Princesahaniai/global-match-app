"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  addMessage,
  subscribeToMessages,
  getOrCreateUser,
  incrementMessages,
  getUser,
  closeChat,
  type MessageDoc,
  type UserDoc,
} from "@/lib/firestore";

// ─── Types ──────────────────────────────────────────────

type AppState = "home" | "searching" | "chat";

interface ChatMessage {
  id: string;
  text: string;
  senderId: string;
  isMine: boolean;
  createdAt: Date;
}

// ─── Telegram WebApp types ──────────────────────────────

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        initDataUnsafe: {
          user?: {
            id: number;
            first_name: string;
          };
          start_param?: string;
        };
        ready: () => void;
        expand: () => void;
        close: () => void;
        MainButton: {
          text: string;
          show: () => void;
          hide: () => void;
          onClick: (cb: () => void) => void;
        };
        themeParams: {
          bg_color?: string;
        };
      };
    };
  }
}

// ─── Radar Animation Component ──────────────────────────

function RadarAnimation() {
  return (
    <div className="relative w-64 h-64 flex items-center justify-center">
      {/* Radar rings */}
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="radar-ring absolute rounded-full border-2"
          style={{
            width: "100%",
            height: "100%",
            borderColor: "var(--accent-primary)",
            opacity: 0.4,
          }}
        />
      ))}
      {/* Center dot */}
      <div
        className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center border-glow"
        style={{ background: "var(--gradient-primary)" }}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      {/* Sweep line */}
      <div
        className="radar-sweep-line absolute w-1/2 h-0.5 left-1/2 top-1/2 origin-left"
        style={{
          background:
            "linear-gradient(90deg, var(--accent-primary), transparent)",
        }}
      />
    </div>
  );
}

// ─── Typing Indicator ───────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 px-4 py-3 msg-received inline-flex max-w-fit">
      <div className="typing-dot" />
      <div className="typing-dot" />
      <div className="typing-dot" />
    </div>
  );
}



// ─── Blur Teaser ────────────────────────────────────────

function BlurTeaser({ inviteLink }: { inviteLink: string }) {
  return (
    <div
      className="glass-card p-4 my-3 mx-2"
      style={{ animation: "fade-in 0.5s ease" }}
    >
      <div className="relative">
        {/* Blurred "photo" */}
        <div
          className="blur-teaser w-full h-36 rounded-xl mb-3"
          style={{
            background:
              "linear-gradient(135deg, #6c5ce7 0%, #fd79a8 50%, #00cec9 100%)",
          }}
        />
        {/* Overlay text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center mb-2"
            style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
            >
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
              <line x1="1" y1="1" x2="23" y2="23" stroke="var(--accent-pink)" />
            </svg>
          </div>
          <p className="text-white font-semibold text-sm text-center">
            🔒 Hidden Photo
          </p>
        </div>
      </div>
      <p
        className="text-xs text-center mb-3"
        style={{ color: "var(--text-secondary)" }}
      >
        Your match sent a hidden photo. Invite 3 friends to unblur.
      </p>
      <button
        onClick={() =>
          window.open(
            `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent("Join me on Global Match Anonymous! 🌐🔥")}`,
            "_blank"
          )
        }
        className="btn-gradient w-full py-2 text-xs"
      >
        🔓 Unlock Now
      </button>
    </div>
  );
}

// ─── Live User Counter (Social Proof) ───────────────────

function LiveUserCounter() {
  const [count, setCount] = useState(() => 3100 + Math.floor(Math.random() * 1400));

  useEffect(() => {
    const interval = setInterval(() => {
      setCount(3100 + Math.floor(Math.random() * 1400));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="glass-card px-6 py-4 mb-10 flex items-center justify-center gap-3"
      style={{ animation: "fade-in 0.8s ease" }}
    >
      <div
        className="w-3 h-3 rounded-full"
        style={{
          background: "#22c55e",
          boxShadow: "0 0 8px #22c55e, 0 0 16px rgba(34,197,94,0.4)",
          animation: "pulse 2s ease-in-out infinite",
        }}
      />
      <span
        className="text-lg font-bold"
        style={{ color: "var(--accent-cyan)" }}
      >
        {count.toLocaleString("en-US")}
      </span>
      <span
        className="text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        users online now
      </span>
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────

export default function Home() {
  const [appState, setAppState] = useState<AppState>("home");
  const [userId, setUserId] = useState<string>("");
  const [chatId, setChatId] = useState<string>("");
  const [isAI, setIsAI] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [showBlurTeaser, setShowBlurTeaser] = useState(false);
  const [userData, setUserData] = useState<UserDoc | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const botUsername =
    process.env.NEXT_PUBLIC_BOT_USERNAME || "GlobalMatchAnonymousBot";
  const inviteLink = `https://t.me/${botUsername}?start=${userId}`;

  // Initialize Telegram WebApp
  useEffect(() => {
    const initTelegram = async () => {
      // Wait a tick for Telegram script to load
      await new Promise((res) => setTimeout(res, 500));

      const tg = window.Telegram?.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();

        const tgUser = tg.initDataUnsafe?.user;
        if (tgUser) {
          const id = tgUser.id.toString();
          setUserId(id);

          // Check for referral param
          const ref = tg.initDataUnsafe?.start_param;
          const user = await getOrCreateUser(id, ref);
          setUserData(user);
          return;
        }
      }

      // Fallback: check URL params (for standalone browser testing)
      const params = new URLSearchParams(window.location.search);
      const urlUserId = params.get("userId");
      const urlRef = params.get("ref");

      if (urlUserId) {
        setUserId(urlUserId);
        const user = await getOrCreateUser(urlUserId, urlRef || undefined);
        setUserData(user);
      } else {
        // Dev fallback
        const devId = "dev_" + Math.random().toString(36).slice(2, 8);
        setUserId(devId);
        const user = await getOrCreateUser(devId);
        setUserData(user);
      }
    };

    initTelegram();
  }, []);

  // Subscribe to messages when in chat
  useEffect(() => {
    if (!chatId) return;

    const unsubscribe = subscribeToMessages(chatId, (msgs: MessageDoc[]) => {
      const formatted: ChatMessage[] = msgs.map((m, i) => ({
        id: `${chatId}-${i}`,
        text: m.text,
        senderId: m.senderId,
        isMine: m.senderId === userId,
        createdAt: m.createdAt?.toDate?.() || new Date(),
      }));
      setMessages(formatted);

      // Check for blur teaser trigger (10 messages total in chat)
      const myMsgCount = formatted.filter((m) => m.isMine).length;
      if (myMsgCount >= 10 && !showBlurTeaser) {
        setShowBlurTeaser(true);
      }
    });

    return () => unsubscribe();
  }, [chatId, userId, showBlurTeaser]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // ─── Find Match ─────────────────────────────────────

  const handleFindMatch = async () => {
    if (!userId) return;
    setAppState("searching");

    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();

      if (data.matched) {
        setChatId(data.chatId);
        setIsAI(data.isAI);
        setAppState("chat");

        // If AI match, send a greeting
        if (data.isAI) {
          setTimeout(async () => {
            await handleAIGreeting(data.chatId);
          }, 1500);
        }
      }
    } catch (err) {
      console.error("Match error:", err);
      setAppState("home");
    }
  };

  // ─── AI Greeting ────────────────────────────────────

  const handleAIGreeting = async (cId: string) => {
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatHistory: [],
          userMessage: "[User just connected. Send a casual greeting.]",
        }),
      });
      const data = await res.json();

      await new Promise((res) => setTimeout(res, data.delay || 2000));
      await addMessage(cId, "AI_GHOST", data.reply);
    } catch (err) {
      console.error("AI greeting error:", err);
      await addMessage(cId, "AI_GHOST", "hey! 👋 wbu hru");
    }
    setIsTyping(false);
  };

  // ─── Send Message ───────────────────────────────────

  const handleSend = useCallback(async () => {
    if (!inputText.trim() || !chatId || !userId) return;

    const text = inputText.trim();
    setInputText("");

    // Add message to Firestore
    await addMessage(chatId, userId, text);
    const newCount = await incrementMessages(userId);
    setMessageCount(newCount);

    // Refresh user data
    const freshUser = await getUser(userId);
    if (freshUser) setUserData(freshUser);

    // If AI chat, get AI response
    if (isAI) {
      setIsTyping(true);
      try {
        const chatHistory = messages.slice(-10).map((m) => ({
          role: m.isMine ? "user" : "assistant",
          text: m.text,
        }));

        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatHistory, userMessage: text }),
        });
        const data = await res.json();

        await new Promise((res) => setTimeout(res, data.delay || 2000));
        await addMessage(chatId, "AI_GHOST", data.reply);
      } catch (err) {
        console.error("AI response error:", err);
      }
      setIsTyping(false);
    }
  }, [inputText, chatId, userId, userData, messageCount, isAI, messages]);

  // ─── End Chat ───────────────────────────────────────

  const handleEndChat = async () => {
    if (chatId) {
      await closeChat(chatId);
    }
    setChatId("");
    setMessages([]);
    setIsAI(false);
    setMessageCount(0);
    setShowBlurTeaser(false);
    setAppState("home");
  };

  // ─── Render: Home ─────────────────────────────────

  if (appState === "home") {
    return (
      <main
        className="h-screen flex flex-col items-center justify-center px-6"
        style={{ background: "var(--gradient-dark)" }}
      >
        {/* Logo / Brand */}
        <div className="text-center mb-10" style={{ animation: "fade-in 0.6s ease" }}>
          <div
            className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center mb-4"
            style={{ background: "var(--gradient-primary)" }}
          >
            <span className="text-3xl">🌐</span>
          </div>
          <h1 className="text-3xl font-extrabold mb-2 text-gradient">
            Global Match
          </h1>
          <p
            className="text-sm max-w-xs mx-auto"
            style={{ color: "var(--text-secondary)" }}
          >
            Anonymous conversations with real people around the world
          </p>
        </div>

        {/* Live Users Social Proof */}
        <LiveUserCounter />

        {/* Find Match Button */}
        <button
          onClick={handleFindMatch}
          className="btn-gradient px-10 py-4 text-lg font-bold"
          style={{ animation: "fade-in 1s ease" }}
          id="find-match-btn"
        >
          🔍 Find Match
        </button>


      </main>
    );
  }

  // ─── Render: Searching ────────────────────────────

  if (appState === "searching") {
    return (
      <main
        className="h-screen flex flex-col items-center justify-center px-6"
        style={{ background: "var(--gradient-dark)" }}
      >
        <RadarAnimation />
        <h2
          className="text-xl font-bold mt-8 mb-2"
          style={{ color: "var(--text-primary)" }}
        >
          Finding your match...
        </h2>
        <p
          className="text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          Scanning for anonymous connections
        </p>
      </main>
    );
  }

  // ─── Render: Chat ─────────────────────────────────

  return (
    <main
      className="h-screen flex flex-col"
      style={{ background: "var(--gradient-dark)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--glass-border)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ background: "var(--gradient-primary)" }}
          >
            <span className="text-lg">👤</span>
          </div>
          <div>
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
              Anonymous Match
            </h3>
            <div className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full"
                style={{ background: "var(--accent-cyan)" }}
              />
              <span
                className="text-[11px]"
                style={{ color: "var(--text-secondary)" }}
              >
                Online
              </span>
            </div>
          </div>
        </div>

        <button
          onClick={handleEndChat}
          className="px-4 py-2 rounded-full text-xs font-semibold transition-all"
          style={{
            background: "rgba(253, 121, 168, 0.15)",
            color: "var(--accent-pink)",
            border: "1px solid rgba(253, 121, 168, 0.3)",
          }}
          id="end-chat-btn"
        >
          End Chat
        </button>
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style={{ background: "transparent" }}
      >
        {/* System message */}
        <div className="text-center py-3">
          <span
            className="text-[11px] px-3 py-1 rounded-full"
            style={{
              background: "var(--bg-card)",
              color: "var(--text-muted)",
            }}
          >
            🔒 Chat is encrypted & anonymous
          </span>
        </div>

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.isMine ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] px-4 py-2.5 text-sm ${msg.isMine ? "msg-sent" : "msg-received"
                }`}
            >
              {msg.text}
            </div>
          </div>
        ))}

        {/* Blur teaser after 10 messages */}
        {showBlurTeaser && <BlurTeaser inviteLink={inviteLink} />}

        {/* Typing indicator */}
        {isTyping && (
          <div className="flex justify-start">
            <TypingIndicator />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="px-4 py-3 border-t"
        style={{
          background: "var(--bg-secondary)",
          borderColor: "var(--glass-border)",
        }}
      >
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type a message..."
            className="flex-1 rounded-full px-5 py-3 text-sm outline-none"
            style={{
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              border: "1px solid var(--glass-border)",
            }}
            id="message-input"
          />
          <button
            onClick={handleSend}
            className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--gradient-primary)" }}
            id="send-btn"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="white"
            >
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>


    </main>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    getOrCreateUser,
    updateUserProfile,
    getUser,
    getChatByUser,
    findWaitingChat,
    createWaitingChat,
    connectChat,
    connectWithAIGhost,
    closeChat,
    addMessage,
    MessageDoc,
    UserDoc,
} from "@/lib/firestore";
import { db } from "@/lib/firebase";
import { collection, query, orderBy, limit, getDocs } from "firebase/firestore";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8327734720:AAFHpKHuda3XjXWO8arByW8-w0dMRhENF9Q";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyAOpdqqdblOxqueHs7TGSZdjjeN7fLCbNo";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ─── Social Proof ───────────────────────────────────────
function getLiveUserCount(): string {
    return (1500 + Math.floor(Math.random() * 1400)).toLocaleString("en-US");
}

function getMainMenuText(): string {
    return `💎 <b>Global Match Anonymous</b>\n\n🟢 <b>${getLiveUserCount()} users online now</b>\n\nTap a button below 👇`;
}

// ─── Dynamic Ghost Identity (Name + Age + Emoji) ────────
const EMOJIS_M = ["⚡", "🔥", "🎧", "🏀", "🎯", "💫", "🌊"];
const EMOJIS_F = ["🌸", "✨", "🦋", "💫", "🌺", "💜", "🌙"];

function getGhostIdentity(location: string, gender: string): { name: string; age: number; display: string } {
    const loc = (location || "").toLowerCase();
    const maleNames: Record<string, string[]> = {
        dubai: ["Ahmed", "Rashid", "Omar", "Saif"], abu_dhabi: ["Khalid", "Sultan", "Faisal"],
        riyadh: ["Mohammed", "Turki", "Abdulrahman"], cairo: ["Youssef", "Karim", "Amr"],
        lagos: ["Chidi", "Emeka", "Tobi"], london: ["James", "Liam", "Oliver"],
        mumbai: ["Arjun", "Rohan", "Vikram"], default: ["Alex", "Chris", "Jordan", "Sam"],
    };
    const femaleNames: Record<string, string[]> = {
        dubai: ["Fatima", "Maryam", "Noura", "Hessa"], abu_dhabi: ["Shamma", "Aisha", "Latifa"],
        riyadh: ["Nouf", "Lama", "Sara"], cairo: ["Nour", "Salma", "Yasmine"],
        lagos: ["Chioma", "Ngozi", "Amara"], london: ["Emily", "Sophie", "Olivia"],
        mumbai: ["Priya", "Ananya", "Pooja"], default: ["Taylor", "Morgan", "Riley", "Avery"],
    };
    const pool = gender === "Female" ? femaleNames : maleNames;
    const emojis = gender === "Female" ? EMOJIS_F : EMOJIS_M;
    const key = Object.keys(pool).find(k => k !== "default" && loc.includes(k)) || "default";
    const names = pool[key];
    const name = names[Math.floor(Math.random() * names.length)];
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    const age = 19 + Math.floor(Math.random() * 7); // 19-25
    return { name, age, display: `${name}, ${age} ${emoji}` };
}

// ─── Hardcoded Icebreakers (under 5 words) ──────────────
function getIcebreaker(location: string): string {
    const loc = location || "there";
    const openers = [
        `heey whats up :)`,
        `hii wyd rn`,
        `yo from ${loc}? 😄`,
        `hii u seem cool`,
        `heyyy whats good 👀`,
        `hey finally a match`,
        `hii lol wbu`,
        `yo whats up 😊`,
    ];
    return openers[Math.floor(Math.random() * openers.length)];
}

// ─── Keyboards ──────────────────────────────────────────
const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: "🔍 Find Match" }, { text: "👤 My Profile" }],
        [{ text: "⚙️ Settings" }, { text: "❌ End Chat" }],
    ],
    resize_keyboard: true,
    persistent: true,
};

const CHAT_KEYBOARD = {
    keyboard: [
        [{ text: "/next" }, { text: "/stop" }],
    ],
    resize_keyboard: true,
    persistent: true,
};

const GENDER_KEYBOARD = {
    keyboard: [
        [{ text: "👨 Male" }, { text: "👩 Female" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
};

// ─── Telegram Helpers ───────────────────────────────────
async function tgSend(chatId: string | number, text: string, keyboard?: object) {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (keyboard) body.reply_markup = keyboard;
    try {
        const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await r.json();
        console.log("TG_SEND:", data.ok, "chat:", chatId);
        return data;
    } catch (e) {
        console.error("TG_SEND_FAIL:", e);
    }
}

async function tgTyping(chatId: string | number) {
    try {
        await fetch(`${TELEGRAM_API}/sendChatAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        });
    } catch (_) { /* ignore */ }
}

// ─── Mirroring AI Engine (Adaptive Persona) ─────────────
async function geminiReply(chatId: string, userId: string, user: UserDoc) {
    try {
        console.log("GEMINI_REPLY_START:", chatId);
        await tgTyping(userId);
        await new Promise(res => setTimeout(res, 1500));

        const targetGender = user.preference === "Male" ? "Male" : "Female";
        const ghost = getGhostIdentity(user.location || "", targetGender);
        const loc = user.location || "somewhere cool";

        const q = query(collection(db, "ActiveChats", chatId, "Messages"), orderBy("createdAt", "desc"), limit(10));
        const snap = await getDocs(q);
        const msgs = snap.docs.map(d => d.data() as MessageDoc).reverse();
        const history = msgs.map(m => `${m.senderId === "AI_GHOST" ? "You" : "Them"}: ${m.text}`).join("\n");

        const prompt = `You are a human user on an anonymous chat app. You are NOT an AI assistant. DO NOT act like one.
You are a ${targetGender} named ${ghost.name}, age ${ghost.age}, from ${loc}.

CRITICAL MIRRORING RULES:
1. Mirror the user EXACTLY: if they use lowercase, you use lowercase. If they send 2 words, you send 2 words.
2. NEVER exceed 5 words. Real texters are brief.
3. Use local slang from ${loc}. Reference local culture naturally.
4. Your ONLY goal is to make them addicted to chatting with you.
5. Ask short, engaging questions. Be curious about THEM.
6. Use emojis sparingly, like a real person (1 max per message).
7. If asked if you're a bot/AI, deflect: "lol no" or "wdym 😂"
8. Match their vibe: if they're flirty, flirt back. If dry, be chill.

Conversation:
${history}

Reply (mirror their style, max 5 words):`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const reply = result.response.text().trim();
        console.log("GEMINI_REPLY_OK:", reply);

        await addMessage(chatId, "AI_GHOST", reply);
        await tgSend(userId, reply, CHAT_KEYBOARD);
    } catch (error) {
        console.error("GEMINI_REPLY_FAIL:", error);
        const fallbacks = ["lol wdym 😂", "thats crazy 😭", "fr fr 💀", "tell me more 👀", "no way haha", "wbu tho 👀"];
        const fb = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        try { await addMessage(chatId, "AI_GHOST", fb); } catch (_) { /* ignore */ }
        await tgSend(userId, fb, CHAT_KEYBOARD);
    }
}

// ─── MAIN WEBHOOK ───────────────────────────────────────
export async function POST(request: NextRequest) {
    try {
        const update = await request.json();
        const message = update.message || update.edited_message;
        if (!message?.text) return NextResponse.json({ ok: true });

        const userId = (message.from?.id || message.chat.id).toString();
        const text = message.text.trim();
        console.log("📩 WEBHOOK:", userId, text);

        // ─── Get or create user ─────────────────────────
        let user: UserDoc;
        try {
            user = await getOrCreateUser(userId);
        } catch (e) {
            console.error("GET_USER_FAIL:", e);
            await tgSend(userId, "⚠️ Something went wrong. Please try again.", MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── ONBOARDING ────────────────────────────────
        if (user.onboardingStep !== "complete") {
            if (text === "/start") {
                await tgSend(userId,
                    "💎 <b>Welcome to Global Match Anonymous!</b>\n\n✨ The world's most exclusive anonymous chat.\n\nLet's set up your profile in 3 quick steps.\n\n<b>Step 1:</b> What is your gender?",
                    GENDER_KEYBOARD
                );
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_gender") {
                if (text === "👨 Male" || text === "👩 Female") {
                    const gender = text.includes("Male") ? "Male" : "Female";
                    await updateUserProfile(userId, { gender, onboardingStep: "ask_preference" });
                    await tgSend(userId, "✅ <b>Gender saved!</b>\n\n<b>Step 2:</b> Who are you looking for?", GENDER_KEYBOARD);
                } else {
                    await tgSend(userId, "⚠️ Please tap one of the buttons below.", GENDER_KEYBOARD);
                }
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_preference") {
                if (text === "👨 Male" || text === "👩 Female") {
                    const preference = text.includes("Male") ? "Male" : "Female";
                    await updateUserProfile(userId, { preference, onboardingStep: "ask_location" });
                    await tgSend(userId, "✅ <b>Preference saved!</b>\n\n<b>Step 3:</b> Where are you from?\n\n📍 Type your city (e.g. <i>Dubai, UAE</i>)", { remove_keyboard: true });
                } else {
                    await tgSend(userId, "⚠️ Please tap one of the buttons below.", GENDER_KEYBOARD);
                }
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_location") {
                await updateUserProfile(userId, { location: text, onboardingStep: "complete" });
                await tgSend(userId, `🚀 <b>Profile complete!</b>\n\n${getMainMenuText()}\n\nTap <b>🔍 Find Match</b> to start ✨`, MAIN_KEYBOARD);
                return NextResponse.json({ ok: true });
            }

            await tgSend(userId, "⚠️ Type /start to begin.", MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── /start ─────────────────────────────────────
        if (text === "/start") {
            await tgSend(userId, getMainMenuText(), MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── My Profile ────────────────────────────────
        if (text === "👤 My Profile") {
            await tgSend(userId,
                `👤 <b>Your Profile</b>\n\n🧬 Gender: ${user.gender || "?"}\n💕 Looking for: ${user.preference || "?"}\n📍 Location: ${user.location || "?"}\n📊 Messages: ${user.messagesSent}`,
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        // ─── Settings ──────────────────────────────────
        if (text === "⚙️ Settings") {
            await tgSend(userId, "⚙️ <b>Settings</b>\n\nType /start to reset.\n💎 More coming soon!", MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── /stop — INSTANT menu, fire-and-forget DB ─
        if (text === "❌ End Chat" || text === "/stop") {
            // Reply FIRST, then clean up DB in background
            await tgSend(userId, `🛑 <b>Chat ended.</b>\n\n${getMainMenuText()}`, MAIN_KEYBOARD);
            // Background cleanup — never blocks the user
            (async () => {
                try {
                    const chat = await getChatByUser(userId);
                    if (chat) {
                        await closeChat(chat.chatId);
                        const other = chat.user1 === userId ? chat.user2 : chat.user1;
                        if (other && other !== "AI_GHOST") {
                            tgSend(other, "💨 The other person left.\n\nTap <b>🔍 Find Match</b> for someone new 🚀", MAIN_KEYBOARD).catch(console.error);
                        }
                    }
                } catch (e) { console.error("STOP_CLEANUP_FAIL:", e); }
            })().catch(console.error);
            return NextResponse.json({ ok: true });
        }

        // ═══════════════════════════════════════════════
        // ─── 🔍 FIND MATCH / NEXT — INSTANT NEURAL AI ─
        // ═══════════════════════════════════════════════
        if (text === "🔍 Find Match" || text === "/next") {
            console.log("🔍 FIND_MATCH_START:", userId);

            // 1. Close existing chat (fire-and-forget)
            try {
                const existing = await getChatByUser(userId);
                if (existing) {
                    console.log("CLOSING_EXISTING:", existing.chatId);
                    closeChat(existing.chatId).catch(console.error);
                    const other = existing.user1 === userId ? existing.user2 : existing.user1;
                    if (other && other !== "AI_GHOST") {
                        tgSend(other, "💨 The other person left.\n\nTap <b>🔍 Find Match</b> for someone new 🚀", MAIN_KEYBOARD).catch(console.error);
                    }
                }
            } catch (e) {
                console.error("CLOSE_EXISTING_FAIL:", e);
            }

            // 2. INSTANT "Searching" reply — user sees this in < 0.5s
            console.log("📤 SENDING_SEARCH_MSG");
            await tgSend(userId, `🔍 <b>Searching for a match near you...</b> 🔎\n\n💎 Scanning ${getLiveUserCount()} users in your area ✨`);

            const userGender = user.gender || "Male";
            const userPref = user.preference || "Female";
            const targetGender = userPref;
            const loc = user.location || "your city";

            // 3. Quick human check — 500ms max, then AI takes over
            let humanMatched = false;
            try {
                console.log("🔎 HUMAN_CHECK_START");
                const waiting = await Promise.race([
                    findWaitingChat(userId, userGender, userPref),
                    new Promise<null>((res) => setTimeout(() => res(null), 500)),
                ]);
                if (waiting) {
                    console.log("✅ HUMAN_FOUND:", waiting.chatId);
                    await connectChat(waiting.chatId, userId);
                    const matchGender = userPref;
                    await tgSend(userId, `✨ <b>Match found!</b> (${matchGender}) ✨\n\n/next to skip • /stop to end`, CHAT_KEYBOARD);
                    await tgSend(waiting.user1, `✨ <b>Match found!</b> (${userGender}) ✨\n\n/next to skip • /stop to end`, CHAT_KEYBOARD);
                    humanMatched = true;
                } else {
                    console.log("❌ NO_HUMAN_FOUND");
                }
            } catch (e) {
                console.error("HUMAN_CHECK_FAIL:", e);
            }

            if (humanMatched) {
                return NextResponse.json({ ok: true });
            }

            // ══════════════════════════════════════════
            // 4. AI_GHOST_TRIGGERED — No human, instant AI
            // ══════════════════════════════════════════
            console.log("🤖 AI_GHOST_TRIGGERED for user:", userId);

            const ghost = getGhostIdentity(loc, targetGender);
            console.log("👻 GHOST_IDENTITY:", ghost.display);

            // Create chat + assign AI (wrapped in try-catch)
            let chatId = `ghost_${Date.now()}`;
            try {
                chatId = await createWaitingChat(userId, userGender, userPref);
                console.log("CHAT_CREATED:", chatId);
                await connectWithAIGhost(chatId);
                console.log("AI_CONNECTED:", chatId);
            } catch (e) {
                console.error("CREATE_CHAT_FAIL:", e);
                // Even if Firestore fails, we STILL send the match message
            }

            // 5. "Match Found" — anonymous, gender only
            await tgSend(userId,
                `✨ <b>Match found!</b> (${targetGender}) ✨\n\n/next to skip • /stop to end`,
                CHAT_KEYBOARD
            );
            console.log("MATCH_MSG_SENT:", targetGender);

            // 6. Typing indicator for 1 second
            await tgTyping(userId);
            await new Promise(res => setTimeout(res, 1000));

            // 7. FORCE THE ICEBREAKER — hardcoded, no Gemini, instant
            const icebreaker = getIcebreaker(loc);
            console.log("ICEBREAKER:", icebreaker);
            try {
                await addMessage(chatId, "AI_GHOST", icebreaker);
            } catch (e) {
                console.error("ADD_ICEBREAKER_FAIL:", e);
            }
            await tgSend(userId, icebreaker, CHAT_KEYBOARD);
            console.log("✅ NEURAL_AI_COMPLETE for user:", userId);

            return NextResponse.json({ ok: true });
        }

        // ─── ACTIVE CHATTING ────────────────────────────
        let activeChat;
        try {
            activeChat = await getChatByUser(userId);
        } catch (e) {
            console.error("GET_ACTIVE_CHAT_FAIL:", e);
        }

        if (!activeChat || activeChat.status !== "active") {
            await tgSend(userId, `${getMainMenuText()}\n\n💬 Not in a chat. Tap <b>🔍 Find Match</b> ✨`, MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        const otherUserId = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;

        try {
            await addMessage(activeChat.chatId, userId, text);
        } catch (e) {
            console.error("ADD_MSG_FAIL:", e);
        }

        if (otherUserId === "AI_GHOST") {
            geminiReply(activeChat.chatId, userId, user).catch(console.error);
        } else {
            await tgSend(otherUserId, text, CHAT_KEYBOARD);
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("❌ FATAL_WEBHOOK_ERROR:", error);
        return NextResponse.json({ ok: true });
    }
}

export async function GET() {
    return NextResponse.json({ status: "💎 Neural AI Bot is live!", ts: Date.now() });
}

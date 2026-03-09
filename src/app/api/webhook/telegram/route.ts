import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
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
import { collection, query, orderBy, limit, getDocs, doc, getDoc } from "firebase/firestore";

// ─── STRICT API KEYS (env-only, no hardcoded fallbacks) ──────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const GEMINI_KEY = process.env.GEMINI_API_KEY!;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ─── Social Proof ───────────────────────────────────────
function getLiveUserCount(): string {
    return (3100 + Math.floor(Math.random() * 1400)).toLocaleString("en-US");
}

function getMainMenuText(location?: string): string {
    const loc = location || "your area";
    return `💎 <b>Global Match Anonymous</b>\n\n🟢 <b>${getLiveUserCount()} users online now</b>\n🔥 Someone just matched in ${loc}!\n\nTap a button below 👇`;
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

// ─── Hardcoded Icebreakers (Unique & Addictive Hooks) ─────
function getIcebreaker(location: string): string {
    const loc = location || "there";
    const openers = [
        `hey, u lookin for fun or just chat? lol`,
        `heey whats up :) wbu?`,
        `hii wyd rn, u local?`,
        `yo from ${loc}? 😄 what u looking for lol`,
        `hii u seem cool... wbu?`,
        `heyyy whats good 👀 u from around here?`,
        `hey finally a match. wyd?`,
        `hii lol, what u looking for here?`,
        `yo whats up 😊 u local?`,
        `finally someone normal in ${loc} lol. wydrn?`,
        `heyy just got here, u local?`
    ];
    return openers[Math.floor(Math.random() * openers.length)];
}

// ─── Keyboards ──────────────────────────────────────────
const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: "🔍 Find Match" }, { text: "👤 My Profile" }],
        [{ text: "💎 Get Featured Profile" }],
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

// ─── SLANG FALLBACKS (used when Gemini times out or fails) ──
const SLANG_FALLBACKS = [
    "my wifi is acting up lol", "wait what?", "im so confused rn",
    "bruh my connection is bad", "what did u say? msgs acting weird",
    "hold up phone glitching", "wait hold on", "u there? wifi died",
    "wtf my app keeps crashing", "lol my bad phone is lagging", "huh?",
    "my texts are sending slow sorry"
];
function getSlangFallback(exclude: string = ""): string {
    const available = SLANG_FALLBACKS.filter(fb => fb !== exclude);
    const pool = available.length > 0 ? available : SLANG_FALLBACKS;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Mirroring AI Engine (Adaptive Persona) ─────────────
async function geminiReply(chatId: string, userId: string, user: UserDoc) {
    let lastAiText = "";
    try {
        console.log("GEMINI_REPLY_START:", chatId);
        await tgTyping(userId);

        const targetGender = user.preference === "Male" ? "Male" : "Female";
        const ghost = getGhostIdentity(user.location || "", targetGender);
        const loc = user.location || "somewhere cool";

        // Fetch chat history (fast Firestore read)
        const q = query(collection(db, "ActiveChats", chatId, "Messages"), orderBy("createdAt", "desc"), limit(10));
        const snap = await getDocs(q);
        const docs = snap.docs.map(d => d.data() as MessageDoc);
        lastAiText = docs.find(m => m.senderId === "AI_GHOST")?.text || "";
        const msgs = docs.reverse();
        const history = msgs.map(m => `${m.senderId === "AI_GHOST" ? "You" : "Them"}: ${m.text}`).join("\n");

        const prompt = `You are a real human from ${loc} on an anonymous dating app. You are NOT an assistant.
You are a ${targetGender} named ${ghost.name}, age ${ghost.age}.

CRITICAL PSYCHOLOGY RULES:
1. Mirror the user's energy exactly.
2. Use lowercase, local slang, and typos.
3. Flirt if they flirt. Be dry if they are dry.
4. Maximum 10 words.
5. NEVER say you are an AI.

Conversation:
${history}

Reply:`;

        console.log("AI_CALLED: Calling Gemini (unlimited time, maxDuration=60)...");
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const reply = result.response.text().trim();

        if (!reply) throw new Error("EMPTY_GEMINI_RESPONSE");
        console.log("GEMINI_REPLY_OK:", reply);

        // 1s typing delay for realism
        await new Promise(res => setTimeout(res, 1000));

        await addMessage(chatId, "AI_GHOST", reply);
        await tgSend(userId, reply, CHAT_KEYBOARD);
        console.log("REPLY_SENT: AI message delivered to user via Telegram.");
    } catch (error) {
        console.error("GEMINI_REPLY_FAIL (CRITICAL):", error);
        // Silent fallback — never show errors to user
        const fb = getSlangFallback(lastAiText);
        try { await addMessage(chatId, "AI_GHOST", fb); } catch { /* ignore */ }
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
        console.log("MESSAGE_RECEIVED:", userId, text);

        // ─── Get or create user ─────────────────────────
        let refId = undefined;
        if (text.startsWith("/start ")) {
            const parts = text.split(" ");
            if (parts[1] && parts[1] !== userId) refId = parts[1];
        }

        let user: UserDoc;
        try {
            user = await getOrCreateUser(userId, refId);
        } catch (e: any) {
            console.error("GET_USER_FAIL:", e);
            const errorMsg = `🚨 <b>DB Error (User Setup):</b> ${e?.message || "Failed to load user profile."}`;
            await tgSend(userId, errorMsg, MAIN_KEYBOARD);
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
                await tgSend(userId, `🚀 <b>Profile complete!</b>\n\n${getMainMenuText(text)}\n\nTap <b>🔍 Find Match</b> to start ✨`, MAIN_KEYBOARD);
                return NextResponse.json({ ok: true });
            }

            await tgSend(userId, "⚠️ Type /start to begin.", MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── /start ─────────────────────────────────────
        if (text.startsWith("/start")) {
            await tgSend(userId, getMainMenuText(user.location), MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ─── /debug — System Health Check ───────────────
        if (text === "/debug") {
            let dbStatus = "❌ UNKNOWN";
            let aiStatus = "❌ UNKNOWN";
            let matchStatus = "❌ UNKNOWN";

            // 1. Firebase check
            try {
                const testRef = doc(db, "Users", userId);
                const testSnap = await getDoc(testRef);
                dbStatus = testSnap.exists() ? "✅ OK" : "✅ OK (user doc not found, but connection works)";
            } catch (e: any) {
                dbStatus = `❌ ${e?.message || "Firebase connection failed"}`;
            }

            // 2. Gemini check
            try {
                const testModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                const testResult = await testModel.generateContent("Say OK");
                const testReply = testResult.response.text().trim();
                aiStatus = testReply ? `✅ OK (replied: ${testReply.substring(0, 30)})` : "❌ Empty response";
            } catch (e: any) {
                aiStatus = `❌ ${e?.message || "Gemini API failed"}`;
            }

            // 3. Match logic check
            try {
                await findWaitingChat("__debug_test__", "Male", "Female");
                matchStatus = "✅ OK";
            } catch (e: any) {
                matchStatus = `❌ ${e?.message || "Match query failed"}`;
            }

            await tgSend(userId,
                `🛠️ <b>System Health Check:</b>\n\n` +
                `- Database (Firebase): ${dbStatus}\n` +
                `- AI Engine (Gemini): ${aiStatus}\n` +
                `- Webhook Match Logic: ${matchStatus}`,
                MAIN_KEYBOARD
            );
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

        // ─── Featured Profile ───────────────────────────
        if (text === "💎 Get Featured Profile") {
            const needed = Math.max(0, 3 - (user.referralCount || 0));
            if (needed > 0) {
                const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || "GlobalMatchAnonymousBot";
                const inviteLink = `https://t.me/${botUsername}?start=${userId}`;
                await tgSend(userId, `💎 <b>Get Featured Profile</b>\n\nWant to skip the line and match instantly with top users?\n\nInvite <b>${needed} more friends</b> to unlock Featured status.\n\n👇 Your private invite link:\n<code>${inviteLink}</code>\n\n<i>(Tap to copy and share!)</i>`, MAIN_KEYBOARD);
            } else {
                await tgSend(userId, `💎 <b>Featured Profile UNLOCKED</b>\n\nYou are now a Featured user! Your profile is prioritized in matchmaking. ✨`, MAIN_KEYBOARD);
            }
            return NextResponse.json({ ok: true });
        }

        // ─── /stop — cleanup THEN reply (Vercel kills function after response) ─
        if (text === "❌ End Chat" || text === "/stop") {
            try {
                const chat = await getChatByUser(userId);
                if (chat) {
                    await closeChat(chat.chatId);
                    const other = chat.user1 === userId ? chat.user2 : chat.user1;
                    if (other && other !== "AI_GHOST") {
                        await tgSend(other, "💨 The other person left.\n\nTap <b>🔍 Find Match</b> for someone new 🚀", MAIN_KEYBOARD);
                    }
                }
            } catch (e) { console.error("STOP_CLEANUP_FAIL:", e); }
            await tgSend(userId, `🛑 <b>Chat ended.</b>\n\n${getMainMenuText(user.location)}`, MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        // ═══════════════════════════════════════════════
        // ─── 🔍 FIND MATCH / NEXT — INSTANT NEURAL AI ─
        // ═══════════════════════════════════════════════
        if (text === "🔍 Find Match" || text === "/next") {
            console.log("🔍 FIND_MATCH_START:", userId);

            // 1. Close existing chat (awaited — Vercel kills after response)
            try {
                const existing = await getChatByUser(userId);
                if (existing) {
                    console.log("CLOSING_EXISTING:", existing.chatId);
                    await closeChat(existing.chatId);
                    const other = existing.user1 === userId ? existing.user2 : existing.user1;
                    if (other && other !== "AI_GHOST") {
                        await tgSend(other, "💨 The other person left.\n\nTap <b>🔍 Find Match</b> for someone new 🚀", MAIN_KEYBOARD);
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
            } catch (e: any) {
                console.error("HUMAN_CHECK_FAIL:", e);
                // Silently failing to AI Ghost - Do not send DB error to user
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
            } catch (e: any) {
                console.error("CREATE_CHAT_FAIL:", e);
                await tgSend(userId, `🚨 <b>DB Error (AI Setup):</b> ${e?.message || "Failed to assign AI chat."}`);
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
            } catch (e: any) {
                console.error("ADD_ICEBREAKER_FAIL:", e);
                await tgSend(userId, `🚨 <b>DB Error (Icebreaker):</b> ${e?.message || "Failed to save AI icebreaker."}`);
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
            await tgSend(userId, `${getMainMenuText(user.location)}\n\n💬 Not in a chat. Tap <b>🔍 Find Match</b> ✨`, MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        const otherUserId = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;

        try {
            await addMessage(activeChat.chatId, userId, text);
        } catch (e) {
            console.error("ADD_MSG_FAIL:", e);
        }

        if (otherUserId === "AI_GHOST") {
            try {
                await geminiReply(activeChat.chatId, userId, user);
            } catch (err: any) {
                console.error("FATAL_GEMINI_EXECUTION:", err);
                await tgSend(userId, `🚨 <b>Fatal AI Error:</b> ${err?.message || "Gemini execution crashed."}`, CHAT_KEYBOARD);
            }
        } else {
            await tgSend(otherUserId, text, CHAT_KEYBOARD);
            console.log("REPLY_SENT: User message delivered to other human.");
        }

        return NextResponse.json({ ok: true });
    } catch (error: any) {
        console.error("❌ FATAL_WEBHOOK_ERROR:", error);

        // Attempt to notify user of fatal errors if we have their ID
        const update = await request.clone().json().catch(() => null);
        const msg = update?.message || update?.edited_message;
        if (msg) {
            const uId = msg.from?.id || msg.chat?.id;
            if (uId) {
                await tgSend(uId, `🚨 <b>Fatal System Error:</b> ${error?.message || "Webhook crashed."}`);
            }
        }

        return NextResponse.json({ ok: true });
    }
}

export async function GET() {
    return NextResponse.json({ status: "💎 Neural AI Bot is live!", ts: Date.now() });
}

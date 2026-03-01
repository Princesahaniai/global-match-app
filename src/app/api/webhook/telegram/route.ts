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

// ─── Social Proof: Fake Live User Count ─────────────────
function getLiveUserCount(): string {
    const base = 1500 + Math.floor(Math.random() * 1400);
    return base.toLocaleString("en-US");
}

function getMainMenuText(): string {
    return `💎 <b>Global Match Anonymous</b>\n\n🟢 <b>${getLiveUserCount()} users online now</b>\n\nTap a button below to get started 👇`;
}

// ─── Dynamic Ghost Identity ─────────────────────────────
const GHOST_EMOJIS_M = ["⚡", "🔥", "🎧", "🏀", "🎯", "💫", "🌊"];
const GHOST_EMOJIS_F = ["🌸", "✨", "🦋", "💫", "🌺", "💜", "🌙"];

function getGhostDisplayName(location: string, gender: string): string {
    const loc = (location || "").toLowerCase();
    const maleNames: Record<string, string[]> = {
        dubai: ["Ahmed", "Rashid", "Omar", "Saif"],
        abu_dhabi: ["Khalid", "Sultan", "Faisal"],
        riyadh: ["Mohammed", "Abdulrahman", "Turki"],
        cairo: ["Youssef", "Karim", "Amr"],
        lagos: ["Chidi", "Emeka", "Tobi"],
        london: ["James", "Liam", "Oliver"],
        mumbai: ["Arjun", "Rohan", "Vikram"],
        default: ["Alex", "Chris", "Jordan", "Sam"],
    };
    const femaleNames: Record<string, string[]> = {
        dubai: ["Fatima", "Maryam", "Noura", "Hessa"],
        abu_dhabi: ["Shamma", "Aisha", "Latifa"],
        riyadh: ["Nouf", "Lama", "Sara"],
        cairo: ["Nour", "Salma", "Yasmine"],
        lagos: ["Chioma", "Ngozi", "Amara"],
        london: ["Emily", "Sophie", "Olivia"],
        mumbai: ["Priya", "Ananya", "Pooja"],
        default: ["Taylor", "Morgan", "Riley", "Avery"],
    };
    const pool = gender === "Female" ? femaleNames : maleNames;
    const emojis = gender === "Female" ? GHOST_EMOJIS_F : GHOST_EMOJIS_M;
    const key = Object.keys(pool).find(k => k !== "default" && loc.includes(k)) || "default";
    const names = pool[key];
    const name = names[Math.floor(Math.random() * names.length)];
    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
    return `${name} ${emoji}`;
}

// ─── Hardcoded Icebreakers (NO Gemini latency) ──────────
function getIcebreaker(location: string): string {
    const loc = location || "your area";
    const openers = [
        `hey! finally someone normal here lol. where u from?`,
        `hii :) noticed you're in ${loc} too... up for a chat?`,
        `heey whats up! ${loc} vibes huh? 😄`,
        `yo! someone from ${loc}? thats cool lol wbu`,
        `hii! u seem interesting 👀 whats good?`,
        `heyyy :) finally matched w someone. wyd rn?`,
        `hey! from ${loc} too? small world lol`,
        `hii whats up! been waiting for a good match 😅`,
    ];
    return openers[Math.floor(Math.random() * openers.length)];
}

// ─── Premium Keyboards ──────────────────────────────────
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
async function sendTelegramMessage(chatId: string | number, text: string, replyMarkup?: object) {
    const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
    };
    if (replyMarkup) {
        body.reply_markup = replyMarkup;
    }
    try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        console.log("TG sendMessage:", JSON.stringify(data));
        return data;
    } catch (error) {
        console.error("sendMessage failed:", error);
    }
}

async function sendTypingIndicator(chatId: string | number) {
    try {
        await fetch(`${TELEGRAM_API}/sendChatAction`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, action: "typing" }),
        });
    } catch (_) { /* ignore */ }
}

// ─── Neural AI Ghost Engine (Gemini for ongoing chat) ───
async function handleAIGhostReply(chatId: string, userId: string, userMessage: string, user: UserDoc) {
    try {
        // 1. Typing indicator for 1.5s
        await sendTypingIndicator(userId);
        await new Promise(res => setTimeout(res, 1500));

        const targetGender = user.preference === "Male" ? "Male" : "Female";
        const ghostName = getGhostDisplayName(user.location || "", targetGender).split(" ")[0];
        const loc = user.location || "somewhere cool";

        // 2. Fetch last 10 messages for context
        const q = query(collection(db, "ActiveChats", chatId, "Messages"), orderBy("createdAt", "desc"), limit(10));
        const snap = await getDocs(q);
        const msgs = snap.docs.map(d => d.data() as MessageDoc).reverse();
        const historyContext = msgs
            .map(m => `${m.senderId === "AI_GHOST" ? "You" : "Them"}: ${m.text}`)
            .join("\n");

        // 3. Generate reply via Gemini
        const SYSTEM_PROMPT = `You are a real human chatting on an anonymous Telegram app. You are NOT an AI assistant.
Your name is ${ghostName}. You are a ${targetGender} from ${loc}.
Rules:
1. NEVER reveal you are an AI. If asked, say 'lol no im real'.
2. Keep messages 2-6 words max, like a real text.
3. Mirror the user's energy. Use lowercase, slang (lol, tbh, rn, wbu, idk), emojis.
4. Ask engaging questions to keep them hooked.
5. You live in ${loc}. Reference local vibes naturally.`;

        const prompt = `${SYSTEM_PROMPT}\n\nConversation:\n${historyContext}\n\nReply (2-6 words, casual):`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const reply = result.response.text().trim();

        await addMessage(chatId, "AI_GHOST", reply);
        await sendTelegramMessage(userId, reply, CHAT_KEYBOARD);
    } catch (error) {
        console.error("Gemini API error:", error);
        // Fallback — never leave user hanging
        const fallbacks = ["lol wdym 😂", "thats crazy 😭", "fr fr 💀", "tell me more 👀", "no way haha"];
        const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        await addMessage(chatId, "AI_GHOST", fallback);
        await sendTelegramMessage(userId, fallback, CHAT_KEYBOARD);
    }
}

// ─── Main Webhook Handler ───────────────────────────────
export async function POST(request: NextRequest) {
    try {
        const update = await request.json();
        console.log("🔥 Incoming Update:", JSON.stringify(update, null, 2));

        const message = update.message || update.edited_message;
        if (!message || !message.text) {
            return NextResponse.json({ ok: true });
        }

        const telegramChatId = message.chat.id.toString();
        const userId = message.from?.id?.toString() || telegramChatId;
        const text = message.text.trim();

        const user = await getOrCreateUser(userId);

        // ─── ONBOARDING ─────────────────────────────────
        if (user.onboardingStep !== "complete") {
            if (text === "/start") {
                await sendTelegramMessage(telegramChatId,
                    "💎 <b>Welcome to Global Match Anonymous!</b>\n\n✨ The world's most exclusive anonymous chat.\n\nLet's set up your profile in 3 quick steps.\n\n<b>Step 1:</b> What is your gender?",
                    GENDER_KEYBOARD
                );
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_gender") {
                if (text === "👨 Male" || text === "👩 Female") {
                    const gender = text.replace(/[^a-zA-Z]/g, "").trim();
                    await updateUserProfile(userId, { gender, onboardingStep: "ask_preference" });
                    await sendTelegramMessage(telegramChatId,
                        "✅ <b>Gender saved!</b>\n\n<b>Step 2:</b> Who are you looking for?",
                        GENDER_KEYBOARD
                    );
                } else {
                    await sendTelegramMessage(telegramChatId, "⚠️ Please tap one of the buttons below.", GENDER_KEYBOARD);
                }
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_preference") {
                if (text === "👨 Male" || text === "👩 Female") {
                    const preference = text.replace(/[^a-zA-Z]/g, "").trim();
                    await updateUserProfile(userId, { preference, onboardingStep: "ask_location" });
                    await sendTelegramMessage(telegramChatId,
                        "✅ <b>Preference saved!</b>\n\n<b>Step 3:</b> Where are you from?\n\n📍 Type your city and country (e.g. <i>Dubai, UAE</i>)",
                        { remove_keyboard: true }
                    );
                } else {
                    await sendTelegramMessage(telegramChatId, "⚠️ Please tap one of the buttons below.", GENDER_KEYBOARD);
                }
                return NextResponse.json({ ok: true });
            }

            if (user.onboardingStep === "ask_location") {
                await updateUserProfile(userId, { location: text, onboardingStep: "complete" });
                await sendTelegramMessage(telegramChatId,
                    `🚀 <b>Profile complete!</b>\n\n${getMainMenuText()}\n\nTap <b>🔍 Find Match</b> to connect with someone right now ✨`,
                    MAIN_KEYBOARD
                );
                return NextResponse.json({ ok: true });
            }

            // Fallback for unrecognized onboarding input
            await sendTelegramMessage(telegramChatId,
                "⚠️ Please follow the steps above, or type /start to restart.",
                { remove_keyboard: true }
            );
            return NextResponse.json({ ok: true });
        }

        // ─── COMMANDS ───────────────────────────────────
        if (text === "/start") {
            await sendTelegramMessage(telegramChatId, getMainMenuText(), MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        if (text === "👤 My Profile") {
            const g = user.gender || "Not set";
            const p = user.preference || "Not set";
            const l = user.location || "Not set";
            await sendTelegramMessage(telegramChatId,
                `👤 <b>Your Profile</b>\n\n🧬 <b>Gender:</b> ${g}\n💕 <b>Looking for:</b> ${p}\n📍 <b>Location:</b> ${l}\n📊 <b>Messages sent:</b> ${user.messagesSent}\n\nTo update, tap <b>⚙️ Settings</b>.`,
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        if (text === "⚙️ Settings") {
            await sendTelegramMessage(telegramChatId,
                "⚙️ <b>Settings</b>\n\nTo reset your profile, type /reset.\nTo change preferences, start over with /start.\n\n💎 More settings coming soon!",
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        if (text === "❌ End Chat" || text === "/stop") {
            const activeChat = await getChatByUser(userId);
            if (activeChat) {
                await closeChat(activeChat.chatId);
                const otherUser = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;
                if (otherUser && otherUser !== "AI_GHOST") {
                    await sendTelegramMessage(otherUser,
                        "💨 The other person left the chat.\n\nTap <b>🔍 Find Match</b> to connect with someone new 🚀",
                        MAIN_KEYBOARD
                    );
                }
            }
            await sendTelegramMessage(userId,
                `🛑 <b>Chat ended.</b>\n\n${getMainMenuText()}\n\nTap <b>🔍 Find Match</b> to find someone new ✨`,
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        // ─── NEURAL AI MATCH: Find Match / Next ─────────
        if (text === "🔍 Find Match" || text === "/next") {
            // Close any existing chat
            const existingChat = await getChatByUser(userId);
            if (existingChat) {
                await closeChat(existingChat.chatId);
                const otherUser = existingChat.user1 === userId ? existingChat.user2 : existingChat.user1;
                if (otherUser && otherUser !== "AI_GHOST") {
                    sendTelegramMessage(otherUser,
                        "💨 The other person left the chat.\n\nTap <b>🔍 Find Match</b> to connect with someone new 🚀",
                        MAIN_KEYBOARD
                    ).catch(console.error); // fire-and-forget, don't block
                }
            }

            const userGender = user.gender || "Male";
            const userPref = user.preference || "Female";
            const targetGender = userPref === "Male" ? "Male" : "Female";
            const ghostDisplay = getGhostDisplayName(user.location || "", targetGender);
            const loc = user.location || "your city";

            // ── STEP 1: INSTANT "Searching" reply (NO SILENCE) ──
            await sendTelegramMessage(userId,
                `🔍 <b>Searching for a match near you...</b> 🔎\n\n💎 Scanning ${getLiveUserCount()} users in your area ✨`
            );

            // ── STEP 2: Check for a real human (instant, no wait) ──
            const waiting = await findWaitingChat(userId, userGender, userPref);
            if (waiting) {
                await connectChat(waiting.chatId, userId);
                await sendTelegramMessage(userId,
                    "✨ <b>Match found!</b>\n\nSay hi to your anonymous match 👋\n\nType /next to skip • /stop to end",
                    CHAT_KEYBOARD
                );
                await sendTelegramMessage(waiting.user1,
                    "✨ <b>Match found!</b>\n\nSomeone just connected with you 👋\n\nType /next to skip • /stop to end",
                    CHAT_KEYBOARD
                );
                return NextResponse.json({ ok: true });
            }

            // ── STEP 3: NO HUMAN → Instant AI Ghost (NO WAITING) ──
            const chatId = await createWaitingChat(userId, userGender, userPref);
            await connectWithAIGhost(chatId);

            // ── STEP 4: "Match found!" with Dynamic Display Name ──
            await sendTelegramMessage(userId,
                `✨ <b>Match found!</b>\n\n🎭 You're now chatting with <b>${ghostDisplay}</b>\n\nType /next to skip • /stop to end`,
                CHAT_KEYBOARD
            );

            // ── STEP 5: Typing indicator for 1.5s (human illusion) ──
            await sendTypingIndicator(userId);
            await new Promise(res => setTimeout(res, 1500));

            // ── STEP 6: HARDCODED ICEBREAKER (no Gemini = no timeout) ──
            const icebreaker = getIcebreaker(loc);
            await addMessage(chatId, "AI_GHOST", icebreaker);
            await sendTelegramMessage(userId, icebreaker, CHAT_KEYBOARD);

            return NextResponse.json({ ok: true });
        }

        // ─── ACTIVE CHATTING ────────────────────────────
        const activeChat = await getChatByUser(userId);
        if (!activeChat || activeChat.status !== "active") {
            await sendTelegramMessage(userId,
                `${getMainMenuText()}\n\n💬 You're not in a chat right now.\n\nTap <b>🔍 Find Match</b> to connect with someone ✨`,
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        const otherUserId = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;

        // Save message to Firestore
        await addMessage(activeChat.chatId, userId, text);

        if (otherUserId === "AI_GHOST") {
            // Fire-and-forget: Gemini reply runs in background
            // Vercel will keep the function alive long enough for this
            handleAIGhostReply(activeChat.chatId, userId, text, user).catch(console.error);
        } else {
            await sendTelegramMessage(otherUserId, text, CHAT_KEYBOARD);
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("❌ Fatal Webhook Error:", error);
        return NextResponse.json({ ok: true });
    }
}

export async function GET() {
    return NextResponse.json({ status: "💎 Global Match Neural AI Bot is live!" });
}

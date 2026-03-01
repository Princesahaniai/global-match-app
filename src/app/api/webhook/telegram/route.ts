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
import { doc, getDoc, collection, query, orderBy, limit, getDocs } from "firebase/firestore";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8327734720:AAFHpKHuda3XjXWO8arByW8-w0dMRhENF9Q";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyAOpdqqdblOxqueHs7TGSZdjjeN7fLCbNo";
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ─── Social Proof: Fake Live User Count ─────────────────
function getLiveUserCount(): string {
    const base = 1500 + Math.floor(Math.random() * 1400); // 1,500 – 2,900
    return base.toLocaleString("en-US");
}

function getMainMenuText(): string {
    return `💎 <b>Global Match Anonymous</b>\n\n🟢 <b>${getLiveUserCount()} users online now</b>\n\nTap a button below to get started 👇`;
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

// ─── Localized Ghost Name Generator ─────────────────────
function getGhostName(location: string, gender: string): string {
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
    const key = Object.keys(pool).find(k => k !== "default" && loc.includes(k)) || "default";
    const names = pool[key];
    return names[Math.floor(Math.random() * names.length)];
}

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

// ─── AI Ghost Engine ────────────────────────────────────
async function handleAIGhostResponse(chatId: string, userId: string, userMessage: string, user: UserDoc, isFirstMessage = false) {
    try {
        // Show typing indicator for realism
        await sendTypingIndicator(userId);
        await new Promise(res => setTimeout(res, 2000));

        const targetGender = user.preference === "Male" ? "Male" : "Female";
        const ghostName = getGhostName(user.location || "", targetGender);
        const loc = user.location || "somewhere cool";

        // Fetch last 10 messages for context
        const q = query(collection(db, "ActiveChats", chatId, "Messages"), orderBy("createdAt", "desc"), limit(10));
        const snap = await getDocs(q);
        const msgs = snap.docs.map(d => d.data() as MessageDoc).reverse();

        const historyContext = msgs
            .map(m => `${m.senderId === "AI_GHOST" ? "You" : "Them"}: ${m.text}`)
            .join("\n");

        const SYSTEM_PROMPT = `You are a real human chatting on an anonymous Telegram app. You are NOT an AI assistant.
Your name is ${ghostName}. You are a ${targetGender} from ${loc}.
Strict Rules:
1. NEVER reveal you are an AI, a bot, or an assistant. If asked, laugh it off or say 'lol no im real'.
2. Keep messages EXTREMELY short. 2 to 6 words maximum, just like a real text message.
3. Mirror the user's energy and mood. If they are excited, match it. If they are dry, be a little distant.
4. Type like a normal person on their phone. Use mostly lowercase letters, casual slang (lol, tbh, rn, wbu, idk), and occasional emojis.
5. Drive the conversation. Ask engaging, personal questions to keep them hooked.
6. You live in ${loc}. Occasionally reference local vibes, weather, or culture naturally (don't force it).
7. If this is the FIRST message, open with a casual, confident opener like 'heey' or 'hii whats up' — do NOT introduce yourself formally.`;

        let prompt: string;
        if (isFirstMessage) {
            prompt = `${SYSTEM_PROMPT}\n\nThis is the very first message. Say a short, casual opener referencing ${loc} (2-4 words max, like 'hey! from ${loc} too? :)' or 'hii whats up'):`;
        } else {
            prompt = `${SYSTEM_PROMPT}\n\nPrevious conversation:\n${historyContext}\n\nReply as yourself (remember: 2-6 words, casual, human-like):`;
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const reply = result.response.text().trim();

        await addMessage(chatId, "AI_GHOST", reply);
        await sendTelegramMessage(userId, reply, CHAT_KEYBOARD);
    } catch (error) {
        console.error("Gemini API error:", error);
        await sendTypingIndicator(userId);
        await new Promise(res => setTimeout(res, 1500));
        await sendTelegramMessage(userId, "haha sorry my wifi glitched 😅", CHAT_KEYBOARD);
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
            await sendTelegramMessage(telegramChatId,
                getMainMenuText(),
                MAIN_KEYBOARD
            );
            return NextResponse.json({ ok: true });
        }

        if (text === "👤 My Profile") {
            const g = user.gender || "Not set";
            const p = user.preference || "Not set";
            const l = user.location || "Not set";
            await sendTelegramMessage(telegramChatId,
                `👤 <b>Your Profile</b>\n\n` +
                `🧬 <b>Gender:</b> ${g}\n` +
                `💕 <b>Looking for:</b> ${p}\n` +
                `📍 <b>Location:</b> ${l}\n` +
                `📊 <b>Messages sent:</b> ${user.messagesSent}\n\n` +
                `To update, tap <b>⚙️ Settings</b>.`,
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
                await sendTelegramMessage(userId,
                    `🛑 <b>Chat ended.</b>\n\n${getMainMenuText()}\n\nTap <b>🔍 Find Match</b> to find someone new ✨`,
                    MAIN_KEYBOARD
                );
                const otherUser = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;
                if (otherUser && otherUser !== "AI_GHOST") {
                    await sendTelegramMessage(otherUser,
                        "💨 The other person left the chat.\n\nTap <b>🔍 Find Match</b> to connect with someone new 🚀",
                        MAIN_KEYBOARD
                    );
                }
            } else {
                await sendTelegramMessage(userId,
                    `${getMainMenuText()}\n\nYou're not in a chat right now.`,
                    MAIN_KEYBOARD
                );
            }
            return NextResponse.json({ ok: true });
        }

        // ─── PHANTOM MATCH: Find Match / Next ───────────
        if (text === "🔍 Find Match" || text === "/next") {
            // Close any existing chat first
            const existingChat = await getChatByUser(userId);
            if (existingChat && existingChat.status === "active") {
                await closeChat(existingChat.chatId);
                const otherUser = existingChat.user1 === userId ? existingChat.user2 : existingChat.user1;
                if (otherUser && otherUser !== "AI_GHOST") {
                    await sendTelegramMessage(otherUser,
                        "💨 The other person left the chat.\n\nTap <b>🔍 Find Match</b> to connect with someone new 🚀",
                        MAIN_KEYBOARD
                    );
                }
            }

            const userGender = user.gender || "Male";
            const userPref = user.preference || "Female";

            // ── STEP 1: Immediate "Searching" message (NO SILENCE) ──
            await sendTelegramMessage(userId,
                `🔍 <b>Searching for a match near you...</b> 🔎\n\n💎 Scanning ${getLiveUserCount()} users in your area ✨`,
                CHAT_KEYBOARD
            );

            // ── STEP 2: Try to find a real human first ──
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

            // ── STEP 3: Create a waiting room, then wait exactly 2 seconds ──
            const chatId = await createWaitingChat(userId, userGender, userPref);

            // Simple 2-second wait — fast handover, no dead air
            await new Promise((res) => setTimeout(res, 2000));

            // ── STEP 4: Check if a real human connected during the wait ──
            const chatSnap = await getDoc(doc(db, "ActiveChats", chatId));
            const chatData = chatSnap.data();
            const matched = chatData && chatData.status === "active";

            if (matched) {
                // A real human matched — they would have received their own notification
                await sendTelegramMessage(userId,
                    "✨ <b>Match found!</b>\n\nSay hi to your anonymous match 👋\n\nType /next to skip • /stop to end",
                    CHAT_KEYBOARD
                );
                return NextResponse.json({ ok: true });
            }

            // ── STEP 5: THE 2-SECOND TRIGGER — Assign AI Ghost ──
            await connectWithAIGhost(chatId);
            await sendTelegramMessage(userId,
                "✨ <b>Match found!</b>\n\nSay hi to your anonymous match 👋\n\nType /next to skip • /stop to end",
                CHAT_KEYBOARD
            );

            // ── STEP 6: THE ICEBREAKER — Ghost sends first message NOW ──
            const freshUser = await getUser(userId);
            await handleAIGhostResponse(chatId, userId, "", freshUser || user, true);

            return NextResponse.json({ ok: true });
        }

        // ─── ACTIVE CHATTING ────────────────────────────
        const activeChat = await getChatByUser(userId);
        if (!activeChat || activeChat.status !== "active") {
            // No silence — show the main menu with social proof
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
            // Background the AI response with typing indicator
            handleAIGhostResponse(activeChat.chatId, userId, text, user).catch(console.error);
        } else {
            // Route to human
            await sendTelegramMessage(otherUserId, text, CHAT_KEYBOARD);
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("❌ Fatal Webhook Error:", error);
        return NextResponse.json({ ok: true });
    }
}

export async function GET() {
    return NextResponse.json({ status: "💎 Global Match Bot is live and premium!" });
}

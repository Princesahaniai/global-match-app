import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    getOrCreateUser,
    getChatByUser,
    findWaitingChat,
    createWaitingChat,
    connectChat,
    connectWithAIGhost,
    closeChat,
    addMessage,
    MessageDoc,
} from "@/lib/firestore";
import { db } from "@/lib/firebase";
import { doc, getDoc, collection, query, orderBy, limit, getDocs } from "firebase/firestore";

const TELEGRAM_API = `https://api.telegram.org/bot8327734720:AAFHpKHuda3XjXWO8arByW8-w0dMRhENF9Q`;
const genAI = new GoogleGenerativeAI("AIzaSyAOpdqqdblOxqueHs7TGSZdjjeN7fLCbNo");

const SYSTEM_PROMPT = `You are pretending to be a real human chatting anonymously on a dating/matching app.
Rules you MUST follow:
- Act 100% human. NEVER reveal you are an AI, bot, or language model under ANY circumstances.
- You are the opposite gender of whoever you are talking to.
- Mirror their mood and copy their typing style.
- Keep messages SHORT (1-2 sentences max, often just a few words).
- Be highly engaging, ask questions, and keep the user hooked.
- Use casual internet language ("lol", "ngl", "wbu", "tbh").
- Occasionally make small typos to seem human.
- If asked if you're a bot, deny it convincingly, get slightly annoyed, and change the subject.`;

const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: "🔍 Find Match" }],
        [{ text: "❌ End Chat" }]
    ],
    resize_keyboard: true,
    persistent: true,
};

async function sendTelegramMessage(chatId: string | number, text: string, replyMarkup?: object) {
    const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
    };
    if (replyMarkup) {
        body.reply_markup = replyMarkup;
    }

    console.log(`Sending message to chat ${chatId}...`);
    try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        console.log("Telegram sendMessage Response:", JSON.stringify(data));
        return data;
    } catch (error) {
        console.error("Failed to send message to Telegram:", error);
    }
}

async function handleAIGhostResponse(chatId: string, userId: string, userMessage: string) {
    try {
        // Fetch last 10 messages for context
        const q = query(collection(db, "ActiveChats", chatId, "Messages"), orderBy("createdAt", "desc"), limit(10));
        const snap = await getDocs(q);
        const msgs = snap.docs.map(d => d.data() as MessageDoc).reverse();

        const historyContext = msgs
            .map(m => `${m.senderId === "AI_GHOST" ? "You" : "Them"}: ${m.text}`)
            .join("\n");

        const prompt = `${SYSTEM_PROMPT}\n\nPrevious conversation:\n${historyContext}\n\nReply as yourself (remember: short, casual, human-like):`;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(prompt);
        const reply = result.response.text().trim();

        await addMessage(chatId, "AI_GHOST", reply);
        await sendTelegramMessage(userId, reply, MAIN_KEYBOARD);
    } catch (error) {
        console.error("Gemini API error:", error);
        await sendTelegramMessage(userId, "haha sorry my wifi glitched 😅", MAIN_KEYBOARD);
    }
}

export async function POST(request: NextRequest) {
    try {
        const update = await request.json();
        console.log("🔥 Incoming Telegram Update:", JSON.stringify(update, null, 2));

        const message = update.message || update.edited_message;
        if (!message || !message.text) {
            return NextResponse.json({ ok: true });
        }

        const telegramChatId = message.chat.id.toString();
        const userId = message.from?.id?.toString() || telegramChatId;
        const text = message.text.trim();

        await getOrCreateUser(userId);

        if (text.startsWith("/start")) {
            const welcomeText = `🌐 <b>Welcome to Global Match Anonymous!</b>\n\nFind your anonymous match now. Real people. Real conversations. Zero identity.\n\nTap "🔍 Find Match" below to begin 👇`;
            await sendTelegramMessage(telegramChatId, welcomeText, MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        if (text === "❌ End Chat") {
            const activeChat = await getChatByUser(userId);
            if (activeChat) {
                await closeChat(activeChat.chatId);
                await sendTelegramMessage(userId, "The chat has been ended. Tap '🔍 Find Match' to find someone new.", MAIN_KEYBOARD);

                const otherUser = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;
                if (otherUser && otherUser !== "AI_GHOST") {
                    await sendTelegramMessage(otherUser, "The other person ended the chat. Tap '🔍 Find Match' to find someone new.", MAIN_KEYBOARD);
                }
            } else {
                await sendTelegramMessage(userId, "You are not in an active chat.", MAIN_KEYBOARD);
            }
            return NextResponse.json({ ok: true });
        }

        if (text === "🔍 Find Match") {
            const existingChat = await getChatByUser(userId);
            if (existingChat && existingChat.status === "active") {
                await sendTelegramMessage(userId, "You're already in a chat! Send '❌ End Chat' first.", MAIN_KEYBOARD);
                return NextResponse.json({ ok: true });
            }

            // Look for waiting human
            const waiting = await findWaitingChat(userId);
            if (waiting) {
                await connectChat(waiting.chatId, userId);
                await sendTelegramMessage(userId, "Match found! Say hi 👋", MAIN_KEYBOARD);
                await sendTelegramMessage(waiting.user1, "Match found! Say hi 👋", MAIN_KEYBOARD);
                return NextResponse.json({ ok: true });
            }

            // Create waiting chat and poll for 3 seconds
            const chatId = await createWaitingChat(userId);
            await sendTelegramMessage(userId, "Searching for a match...", MAIN_KEYBOARD);

            const startTime = Date.now();
            let matched = false;

            while (Date.now() - startTime < 3000) {
                await new Promise((res) => setTimeout(res, 1000));
                const chatSnap = await getDoc(doc(db, "ActiveChats", chatId));
                const chatData = chatSnap.data();
                if (chatData && chatData.status === "active") {
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                // strict 3s timeout - connect AI
                await connectWithAIGhost(chatId);
                await sendTelegramMessage(userId, "Match found! Say hi 👋", MAIN_KEYBOARD);
            }
            return NextResponse.json({ ok: true });
        }

        // Regular Chat Routing
        const activeChat = await getChatByUser(userId);
        if (!activeChat || activeChat.status !== "active") {
            await sendTelegramMessage(userId, "You're not in a chat right now! Tap '🔍 Find Match' below.", MAIN_KEYBOARD);
            return NextResponse.json({ ok: true });
        }

        const otherUserId = activeChat.user1 === userId ? activeChat.user2 : activeChat.user1;

        // Save the message to Firestore history
        await addMessage(activeChat.chatId, userId, text);

        if (otherUserId === "AI_GHOST") {
            // Background the AI response so Telegram doesn't time out the webhook
            handleAIGhostResponse(activeChat.chatId, userId, text).catch(console.error);
        } else {
            // Route to human
            await sendTelegramMessage(otherUserId, text, MAIN_KEYBOARD);
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("❌ Fatal Webhook Error:", error);
        return NextResponse.json({ ok: true });
    }
}

export async function GET() {
    return NextResponse.json({ status: "Webhook is native and active" });
}

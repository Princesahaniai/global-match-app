import { NextRequest, NextResponse } from "next/server";

const TELEGRAM_API = `https://api.telegram.org/bot8327734720:AAFHpKHuda3XjXWO8arByW8-w0dMRhENF9Q`;

async function sendTelegramMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: object
) {
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

export async function POST(request: NextRequest) {
    try {
        const update = await request.json();
        console.log("🔥 Incoming Telegram Update:", JSON.stringify(update, null, 2));

        // 1. Extract correct chat.id
        const message = update.message || update.edited_message || update.callback_query?.message;

        if (!message) {
            console.log("No valid message found in update. Ignoring.");
            return NextResponse.json({ ok: true });
        }

        const chatId = message.chat?.id;
        console.log("✅ Extracted Chat ID:", chatId);

        if (!chatId) {
            console.log("No Chat ID found. Aborting.");
            return NextResponse.json({ ok: true });
        }

        // Handle /start command
        if (message.text?.startsWith("/start")) {
            const userId = message.from?.id?.toString() || "";
            const args = message.text.split(" ");
            const referrerId = args.length > 1 ? args[1] : undefined;

            // Use the actual deployed Vercel URL as a safe fallback instead of localhost to prevent Telegram API 400 errors
            const tmaUrl = process.env.NEXT_PUBLIC_TMA_URL || "https://global-match-app.vercel.app";
            const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || "GlobalMatchAnonymousBot";

            const welcomeText = referrerId
                ? `🌐 <b>Welcome to Global Match Anonymous!</b>\n\nYou were invited by a friend! Tap below to start matching anonymously.`
                : `🌐 <b>Welcome to Global Match Anonymous!</b>\n\nFind your anonymous match now. Real people. Real conversations. Zero identity.\n\nTap below to begin 👇`;

            // 2. Force guaranteed reply
            await sendTelegramMessage(chatId, welcomeText, {
                inline_keyboard: [
                    [
                        {
                            text: "🔍 Open Global Match",
                            web_app: {
                                url: `${tmaUrl}?userId=${userId}${referrerId ? `&ref=${referrerId}` : ""}`,
                            },
                        },
                    ],
                    [
                        {
                            text: "📨 Invite Friends",
                            url: `https://t.me/share/url?url=${encodeURIComponent(
                                `https://t.me/${botUsername}?start=${userId}`
                            )}&text=${encodeURIComponent(
                                "Join me on Global Match Anonymous! 🌐🔥"
                            )}`,
                        },
                    ],
                ],
            });

            return NextResponse.json({ ok: true });
        }

        // Handle regular messages
        if (message.text) {
            const tmaUrl = process.env.NEXT_PUBLIC_TMA_URL || "https://global-match-app.vercel.app";
            await sendTelegramMessage(
                chatId,
                "💬 Open the app to start chatting anonymously!",
                {
                    inline_keyboard: [
                        [
                            {
                                text: "🔍 Open Global Match",
                                web_app: {
                                    url: tmaUrl,
                                },
                            },
                        ],
                    ],
                }
            );
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("❌ Fatal Webhook Error:", error);
        return NextResponse.json({ ok: true }); // Always return 200 to Telegram so it doesn't retry endlessly
    }
}

// Telegram sends GET to verify webhook
export async function GET() {
    return NextResponse.json({ status: "Webhook is active (New Version)" });
}

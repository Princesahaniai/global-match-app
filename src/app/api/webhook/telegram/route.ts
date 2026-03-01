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
    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

export async function POST(request: NextRequest) {
    try {
        const update = await request.json();

        // Handle /start command
        if (update.message?.text?.startsWith("/start")) {
            const chatId = update.message.chat.id;
            const userId = update.message.from.id.toString();
            const args = update.message.text.split(" ");
            const referrerId = args.length > 1 ? args[1] : undefined;

            // Register user via our internal API (will be handled client-side in TMA)
            // For now, just send the Web App button
            const tmaUrl = process.env.NEXT_PUBLIC_TMA_URL || "https://localhost:3000";
            const botUsername = process.env.NEXT_PUBLIC_BOT_USERNAME || "GlobalMatchAnonymousBot";

            const welcomeText = referrerId
                ? `🌐 <b>Welcome to Global Match Anonymous!</b>\n\nYou were invited by a friend! Tap below to start matching anonymously.`
                : `🌐 <b>Welcome to Global Match Anonymous!</b>\n\nFind your anonymous match now. Real people. Real conversations. Zero identity.\n\nTap below to begin 👇`;

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

        // Handle regular messages (for potential future in-bot chat)
        if (update.message?.text) {
            const chatId = update.message.chat.id;
            await sendTelegramMessage(
                chatId,
                "💬 Open the app to start chatting anonymously!",
                {
                    inline_keyboard: [
                        [
                            {
                                text: "🔍 Open Global Match",
                                web_app: {
                                    url: process.env.NEXT_PUBLIC_TMA_URL || "https://localhost:3000",
                                },
                            },
                        ],
                    ],
                }
            );
        }

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error("Webhook error:", error);
        return NextResponse.json({ ok: true }); // Always return 200 to Telegram
    }
}

// Telegram sends GET to verify webhook
export async function GET() {
    return NextResponse.json({ status: "Webhook is active" });
}

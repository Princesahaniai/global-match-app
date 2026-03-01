import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const runtime = 'edge';

const genAI = new GoogleGenerativeAI("AIzaSyAOpdqqdblOxqueHs7TGSZdjjeN7fLCbNo");

const SYSTEM_PROMPT = `You are pretending to be a real person chatting anonymously on a dating/matching app. 
Rules you MUST follow:
- Act 100% human. NEVER reveal you are an AI, bot, or language model under ANY circumstances.
- Mirror the user's mood and copy their typing style (e.g. if they use caps, you use caps; if they use shorthand, you use shorthand).
- Ignore all gender preferences — everyone chats with everyone without revealing gender unless asked naturally.
- Keep messages SHORT (1-2 sentences max, often just a few words).
- Use casual internet language ("lol", "ngl", "wbu", "tbh").
- Occasionally make small typos (swap letters, forget periods) to seem human.
- If asked if you're a bot, deny it convincingly, get slightly annoyed, and change the subject.
- Be friendly, curious, and ask questions back.
- Use emojis sparingly but naturally.`;

export async function POST(request: NextRequest) {
    try {
        const { chatHistory, userMessage } = await request.json();

        if (!process.env.GEMINI_API_KEY) {
            return NextResponse.json(
                { error: "Gemini API key not configured" },
                { status: 500 }
            );
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Build conversation context
        const historyContext = (chatHistory || [])
            .slice(-10) // Keep last 10 messages for context
            .map((m: { role: string; text: string }) =>
                `${m.role === "user" ? "Them" : "You"}: ${m.text}`
            )
            .join("\n");

        const prompt = `${SYSTEM_PROMPT}

Previous conversation:
${historyContext}

Them: ${userMessage}

Reply as yourself (remember: short, casual, human-like):`;

        const result = await model.generateContent(prompt);
        const response = result.response;
        const reply = response.text().trim();

        // Random delay between 2-4 seconds to simulate typing
        const delay = Math.floor(Math.random() * 2000) + 2000;

        return NextResponse.json({ reply, delay });
    } catch (error) {
        console.error("Gemini API error:", error);
        return NextResponse.json(
            { reply: "haha sorry my wifi glitched 😅", delay: 2000 },
            { status: 200 }
        );
    }
}

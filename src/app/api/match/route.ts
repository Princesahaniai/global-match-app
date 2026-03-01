import { NextRequest, NextResponse } from "next/server";

export const runtime = 'edge';

export async function POST(request: NextRequest) {
    try {
        const { userId } = await request.json();

        // Dynamic import to avoid issues with server-side Firebase
        const { getOrCreateUser, findWaitingChat, createWaitingChat, connectChat, connectWithAIGhost } = await import("@/lib/firestore");

        // Ensure user exists
        await getOrCreateUser(userId);

        // Try to find a waiting chat
        const waiting = await findWaitingChat(userId);
        if (waiting) {
            await connectChat(waiting.chatId, userId);
            return NextResponse.json({
                chatId: waiting.chatId,
                isAI: false,
                matched: true,
            });
        }

        // No one waiting — create a waiting chat
        const chatId = await createWaitingChat(userId);

        // Wait up to 3 seconds polling for a match
        const startTime = Date.now();
        const { doc, getDoc } = await import("firebase/firestore");
        const { db } = await import("@/lib/firebase");

        while (Date.now() - startTime < 3000) {
            await new Promise((res) => setTimeout(res, 1000));
            const chatSnap = await getDoc(doc(db, "ActiveChats", chatId));
            const chatData = chatSnap.data();
            if (chatData && chatData.status === "active") {
                return NextResponse.json({
                    chatId,
                    isAI: chatData.user2 === "AI_GHOST",
                    matched: true,
                });
            }
        }

        // Timeout — connect with AI Ghost
        await connectWithAIGhost(chatId);
        return NextResponse.json({
            chatId,
            isAI: true,
            matched: true,
        });
    } catch (error) {
        console.error("Match error:", error);
        return NextResponse.json(
            { error: "Failed to find match" },
            { status: 500 }
        );
    }
}

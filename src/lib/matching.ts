import {
    findWaitingChat,
    createWaitingChat,
    connectChat,
    connectWithAIGhost,
    getChatByUser,
} from "./firestore";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

export interface MatchResult {
    chatId: string;
    isAI: boolean;
}

/**
 * Attempts to find a human match for the user.
 * - If a waiting chat exists, connects them.
 * - Otherwise creates a waiting chat and waits up to 5s.
 * - If no one joins within 5s, connects with AI_GHOST.
 */
export async function findMatch(userId: string): Promise<MatchResult> {
    // Check if user already has an active chat
    const existing = await getChatByUser(userId);
    if (existing && existing.status === "active") {
        return {
            chatId: existing.chatId,
            isAI: existing.user2 === "AI_GHOST" || existing.user1 === "AI_GHOST",
        };
    }

    // Try to find a waiting chat from another user
    const waiting = await findWaitingChat(userId);
    if (waiting) {
        await connectChat(waiting.chatId, userId);
        return { chatId: waiting.chatId, isAI: false };
    }

    // No one waiting — create our own waiting chat
    const chatId = await createWaitingChat(userId);

    // Wait up to 5 seconds for someone to join
    return new Promise<MatchResult>((resolve) => {
        let resolved = false;

        const unsubscribe = onSnapshot(
            doc(db, "ActiveChats", chatId),
            (snap) => {
                if (resolved) return;
                const data = snap.data();
                if (data && data.status === "active") {
                    resolved = true;
                    unsubscribe();
                    resolve({
                        chatId,
                        isAI: data.user2 === "AI_GHOST",
                    });
                }
            }
        );

        // 5 second timeout → AI fallback
        setTimeout(async () => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            await connectWithAIGhost(chatId);
            resolve({ chatId, isAI: true });
        }, 5000);
    });
}

import { db } from "./firebase";
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    increment,
    collection,
    query,
    where,
    getDocs,
    addDoc,
    orderBy,
    onSnapshot,
    serverTimestamp,
    limit,
    Timestamp,
    deleteDoc,
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";

// ─── Users ──────────────────────────────────────────────

export interface UserDoc {
    userId: string;
    referralCount: number;
    messagesSent: number;
    isUnlimited: boolean;
    referredBy?: string;
    createdAt: Timestamp;
    gender?: string;
    preference?: string;
    location?: string;
    onboardingStep: "ask_gender" | "ask_preference" | "ask_location" | "complete";
}

export async function getOrCreateUser(
    telegramId: string,
    referredBy?: string
): Promise<UserDoc> {
    const ref = doc(db, "Users", telegramId);
    const snap = await getDoc(ref);

    if (snap.exists()) {
        return snap.data() as UserDoc;
    }

    const newUser: UserDoc = {
        userId: telegramId,
        referralCount: 0,
        messagesSent: 0,
        isUnlimited: false,
        createdAt: Timestamp.now(),
        onboardingStep: "ask_gender",
    };

    if (referredBy) {
        newUser.referredBy = referredBy;
    }

    await setDoc(ref, newUser);

    // Credit referrer
    if (referredBy) {
        await incrementReferral(referredBy);
    }

    return newUser;
}

export async function updateUserProfile(userId: string, updates: Partial<UserDoc>): Promise<void> {
    const ref = doc(db, "Users", userId);
    await updateDoc(ref, updates as Record<string, unknown>);
}

export async function getUser(telegramId: string): Promise<UserDoc | null> {
    const ref = doc(db, "Users", telegramId);
    const snap = await getDoc(ref);
    return snap.exists() ? (snap.data() as UserDoc) : null;
}

export async function incrementMessages(userId: string): Promise<number> {
    const ref = doc(db, "Users", userId);
    await updateDoc(ref, { messagesSent: increment(1) });
    const snap = await getDoc(ref);
    return (snap.data() as UserDoc).messagesSent;
}

export async function incrementReferral(referrerId: string): Promise<void> {
    const ref = doc(db, "Users", referrerId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const data = snap.data() as UserDoc;
    const newCount = data.referralCount + 1;
    const updates: Record<string, unknown> = { referralCount: increment(1) };
    if (newCount >= 3) {
        updates.isUnlimited = true;
    }
    await updateDoc(ref, updates);
}

// ─── ActiveChats ────────────────────────────────────────

export interface ChatDoc {
    chatId: string;
    user1: string;
    user2: string;
    status: "waiting" | "active" | "closed";
    lastMessageAt: Timestamp;
    waiterGender: string;
    waiterPreference: string;
}

export async function findWaitingChat(
    excludeUserId: string,
    userGender: string,
    userPreference: string
): Promise<ChatDoc | null> {
    const q = query(
        collection(db, "ActiveChats"),
        where("status", "==", "waiting"),
        where("waiterGender", "==", userPreference),
        where("waiterPreference", "==", userGender),
        where("user1", "!=", excludeUserId),
        limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) return null;
    return snap.docs[0].data() as ChatDoc;
}

export async function createWaitingChat(
    userId: string,
    userGender: string,
    userPreference: string
): Promise<string> {
    const chatId = uuidv4();
    const chatDoc: ChatDoc = {
        chatId,
        user1: userId,
        user2: "",
        status: "waiting",
        lastMessageAt: Timestamp.now(),
        waiterGender: userGender,
        waiterPreference: userPreference,
    };
    await setDoc(doc(db, "ActiveChats", chatId), chatDoc);
    return chatId;
}

export async function connectChat(
    chatId: string,
    user2Id: string
): Promise<void> {
    await updateDoc(doc(db, "ActiveChats", chatId), {
        user2: user2Id,
        status: "active",
        lastMessageAt: serverTimestamp(),
    });
}

export async function connectWithAIGhost(chatId: string): Promise<void> {
    await updateDoc(doc(db, "ActiveChats", chatId), {
        user2: "AI_GHOST",
        status: "active",
        lastMessageAt: serverTimestamp(),
    });
}

export async function closeChat(chatId: string): Promise<void> {
    await updateDoc(doc(db, "ActiveChats", chatId), {
        status: "closed",
        lastMessageAt: serverTimestamp(),
    });
}

export async function getChatByUser(
    userId: string
): Promise<ChatDoc | null> {
    // Check as user1
    const q1 = query(
        collection(db, "ActiveChats"),
        where("user1", "==", userId),
        where("status", "in", ["waiting", "active"]),
        limit(1)
    );
    const snap1 = await getDocs(q1);
    if (!snap1.empty) return snap1.docs[0].data() as ChatDoc;

    // Check as user2
    const q2 = query(
        collection(db, "ActiveChats"),
        where("user2", "==", userId),
        where("status", "==", "active"),
        limit(1)
    );
    const snap2 = await getDocs(q2);
    if (!snap2.empty) return snap2.docs[0].data() as ChatDoc;

    return null;
}

export async function deleteChat(chatId: string): Promise<void> {
    await deleteDoc(doc(db, "ActiveChats", chatId));
}

// ─── Messages subcollection ─────────────────────────────

export interface MessageDoc {
    senderId: string;
    text: string;
    createdAt: Timestamp;
}

export async function addMessage(
    chatId: string,
    senderId: string,
    text: string
): Promise<void> {
    await addDoc(collection(db, "ActiveChats", chatId, "Messages"), {
        senderId,
        text,
        createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "ActiveChats", chatId), {
        lastMessageAt: serverTimestamp(),
    });
}

export function subscribeToMessages(
    chatId: string,
    callback: (messages: MessageDoc[]) => void
) {
    const q = query(
        collection(db, "ActiveChats", chatId, "Messages"),
        orderBy("createdAt", "asc")
    );
    return onSnapshot(q, (snapshot) => {
        const msgs = snapshot.docs.map((d) => d.data() as MessageDoc);
        callback(msgs);
    });
}

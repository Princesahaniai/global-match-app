import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCjQ9VLmqcoucEoXkoG0qQye-FyaOMcua4",
  authDomain: "global-match-db.firebaseapp.com",
  projectId: "global-match-db",
  storageBucket: "global-match-db.firebasestorage.app",
  messagingSenderId: "55023828878",
  appId: "1:55023828878:web:0fe731db7d1bdaa11feedf",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

export { db };

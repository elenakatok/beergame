// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "REDACTED_API_KEY",
  authDomain: "beer-game-f65a8.firebaseapp.com",
  projectId: "beer-game-f65a8",
  storageBucket: "beer-game-f65a8.firebasestorage.app",
  messagingSenderId: "904687304214",
  appId: "1:904687304214:web:ce51dfd4c4b0c9cf4fbf37",
  measurementId: "G-FQFZJWCR3F"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);

export default app;
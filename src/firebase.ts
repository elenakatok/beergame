/// <reference types="vite/client" />
// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore, setLogLevel, connectFirestoreEmulator } from "firebase/firestore";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator } from "firebase/functions";

// Local-only: when running against the Firebase Emulator Suite we skip App Check
// (the Functions emulator does not enforce it) and point every SDK at localhost.
const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === "true";

// Enable verbose Firestore logging in dev to surface permission/connection issues.
if (import.meta.env.DEV) {
  setLogLevel("debug");
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const requiredKeys: Array<keyof typeof firebaseConfig> = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];

const missingKeys = requiredKeys.filter(
  (key) => !firebaseConfig[key] || firebaseConfig[key]?.length === 0
);

if (missingKeys.length > 0) {
  throw new Error(
    `Missing Firebase config values: ${missingKeys.join(
      ", "
    )}. Check your .env VITE_FIREBASE_* settings.`
  );
}

const app = initializeApp(firebaseConfig);

if (import.meta.env.DEV) {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
  // @ts-expect-error - runtime-only debug token on `self` for App Check (not present in TypeScript DOM types)
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken && debugToken.length > 0 ? debugToken : true;
}

// App Check talks to reCAPTCHA + the real backend, so only initialize it when we
// are NOT running fully local against the emulators.
if (!USE_EMULATORS) {
  // Initialize App Check without assigning the returned value to avoid unused variable.
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(
      import.meta.env.VITE_RECAPTCHA_SITE_KEY
    ),
    isTokenAutoRefreshEnabled: true,
  });
}

export const db = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app, "us-central1");

if (USE_EMULATORS) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export default app;

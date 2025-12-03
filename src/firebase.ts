/// <reference types="vite/client" />
// src/firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore, setLogLevel } from "firebase/firestore";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";

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
  // @ts-expect-error - runtime-only debug token on `self` for App Check (not present in TypeScript DOM types)
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

// Initialize App Check without assigning the returned value to avoid unused variable.
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(
    import.meta.env.VITE_APPCHECK_RECAPTCHA_SITE_KEY
  ),
  isTokenAutoRefreshEnabled: true,
});

export const db = getFirestore(app);

export default app;

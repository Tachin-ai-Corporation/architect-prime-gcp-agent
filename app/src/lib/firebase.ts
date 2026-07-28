// lib/firebase.ts — Client-side Firebase Firestore singleton
// Original module
// Used by dashboard client components for real-time Firestore access

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// projectId comes from NEXT_PUBLIC_FIREBASE_PROJECT, inlined at build time.
// NO hardcoded fallback: this repo is a public template, and a real project id
// here would ship one deployment's project to every fork. Consistent with the
// API routes, which all read process.env.GCP_PROJECT_ID with no default.
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT || '';

if (!projectId && typeof window !== 'undefined') {
  console.error(
    '[firebase] NEXT_PUBLIC_FIREBASE_PROJECT is not set — Firestore reads will fail. ' +
      'Set it in app/.env.local and rebuild (it is inlined at build time, not read at runtime).'
  );
}

const firebaseConfig = { projectId };

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);

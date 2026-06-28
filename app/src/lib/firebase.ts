// lib/firebase.ts — Client-side Firebase Firestore singleton
// Original module
// Used by dashboard client components for real-time Firestore access

import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT || 'architect-prime-beta',
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db = getFirestore(app);

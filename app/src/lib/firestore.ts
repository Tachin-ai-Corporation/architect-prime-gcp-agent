import { Firestore } from "@google-cloud/firestore";

let _db: Firestore | null = null;

/**
 * Singleton Firestore client.
 * On Cloud Run: auto-authenticates via attached SA.
 * Locally: uses ADC (run `gcloud auth application-default login`).
 */
export function getDb(): Firestore {
  if (!_db) {
    _db = new Firestore({
      projectId: process.env.GCP_PROJECT_ID,
      databaseId: process.env.FIRESTORE_DATABASE || "(default)",
    });
  }
  return _db;
}

/* ---- Collection helpers ---- */

export function primesCol() {
  return getDb().collection("primes");
}

export function messagesCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("messages");
}

export function fleetCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("fleet");
}

/* ---- Types ---- */

export interface PrimeDoc {
  id: string;
  name: string;
  status: "online" | "offline" | "deploying" | "error";
  zone: string;
  vmName: string;
  coreRef: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
}

export interface MessageDoc {
  id: string;
  sender: "admin" | "prime";
  text: string;
  timestamp: FirebaseFirestore.Timestamp;
  processed: boolean;
}

export interface FleetDoc {
  name: string;
  status: "online" | "offline" | "deploying" | "error";
  specialty: string;
  email: string;
  vmName: string;
  createdAt: FirebaseFirestore.Timestamp;
}

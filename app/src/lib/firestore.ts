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
  status: "online" | "offline" | "deploying" | "needs_action" | "tearing_down" | "removed" | "error";
  specialty: string;
  email: string;
  vmName: string;
  createdAt: FirebaseFirestore.Timestamp;
  deploySteps?: DeployStep[];
  actionRequired?: ActionRequired | null;
}

export interface DeployStep {
  id: string;
  label: string;
  status: "done" | "active" | "pending" | "failed" | "skipped";
  timestamp: string;
  detail?: string;
}

export interface ActionRequired {
  type: string;
  title: string;
  instructions: string[];
}

/* ---- Commands ---- */

export function commandsCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("commands");
}

export type CommandType =
  | "fleet_deploy"
  | "fleet_teardown"
  | "fleet_upgrade"
  | "upgrade_corekit"
  | "gateway_restart"
  | "dashboard_deploy";

export interface CommandDoc {
  type: CommandType;
  args: Record<string, string>;
  status: "pending" | "running" | "complete" | "failed";
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
  result?: string;
  error?: string;
}


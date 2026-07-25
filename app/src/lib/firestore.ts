// lib/firestore.ts — Server-side Firestore client + collection helpers + doc types
import type { DeployStep, ActionRequired } from './types';
// Original module
// Used by all API routes for Firestore access
//
// Singleton pattern: getDb() creates one Firestore client per process.
// Collection helpers provide typed access to the document hierarchy.

import { Firestore } from "@google-cloud/firestore";

// ---- Singleton ----

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

// ---- Collection helpers ----

export function primesCol() {
  return getDb().collection("primes");
}

export function messagesCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("messages");
}

export function fleetCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("fleet");
}

export function fleetMessagesCol(primeId: string, agentName: string) {
  return getDb().collection("primes").doc(primeId).collection("fleet").doc(agentName).collection("messages");
}

export function fleetSkillsCol(primeId: string, agentName: string) {
  return getDb().collection("primes").doc(primeId).collection("fleet").doc(agentName).collection("skills");
}

export function commandsCol(primeId: string) {
  return getDb().collection("primes").doc(primeId).collection("commands");
}

// ---- Deployment-rooted collections (C-1: work artifacts at project level) ----

export function workCol() {
  return getDb().collection("work");
}

export function approvalsCol() {
  return getDb().collection("approvals");
}

export function processesCol() {
  return getDb().collection("processes");
}

export function skillProposalsCol() {
  return getDb().collection("skill-proposals");
}

export function projectsCol() {
  return getDb().collection("projects");
}

export function promotionsCol(projectId: string) {
  return getDb().collection("projects").doc(projectId).collection("promotions");
}

export function secretsCol() {
  return getDb().collection("config").doc("secrets").collection("items");
}

// ---- Document types ----

export interface PrimeDoc {
  id: string;
  name: string;
  status: "online" | "offline" | "deploying" | "tearing_down" | "removed" | "error";
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

// DeployStep and ActionRequired imported from ./types

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

export interface SecretGrant {
  agentEmail: string;
  serviceAccount: string;
  grantedAt: FirebaseFirestore.Timestamp;
  grantedBy: string;
}

export interface SecretMetadata {
  name: string;
  description: string;
  secretManagerName: string;
  createdAt: FirebaseFirestore.Timestamp;
  createdBy: string;
  grants: SecretGrant[];
}

/**
 * Secret Manager REST API helper.
 * Uses Google Auth Library (ADC) for authentication.
 * No @google-cloud/secret-manager dependency — direct REST calls.
 */

import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

function projectId(): string {
  const id = process.env.GCP_PROJECT_ID;
  if (!id) throw new Error("GCP_PROJECT_ID not set");
  return id;
}

/** Prefixed secret name in Secret Manager */
function smName(name: string): string {
  return `aps-secret-${name}`;
}

/** Base URL for Secret Manager API */
function baseUrl(): string {
  return `https://secretmanager.googleapis.com/v1/projects/${projectId()}`;
}

/** Get auth headers for SM API calls */
async function headers(): Promise<Record<string, string>> {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return {
    Authorization: `Bearer ${token.token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Create a new secret with an initial version.
 */
export async function createSecret(name: string, value: string): Promise<void> {
  const h = await headers();
  const secretId = smName(name);

  // Step 1: Create the secret resource
  const createRes = await fetch(`${baseUrl()}/secrets?secretId=${secretId}`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      replication: { automatic: {} },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create secret '${name}': ${createRes.status} ${err}`);
  }

  // Step 2: Add the initial version
  const versionRes = await fetch(`${baseUrl()}/secrets/${secretId}:addVersion`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      payload: { data: Buffer.from(value).toString("base64") },
    }),
  });

  if (!versionRes.ok) {
    const err = await versionRes.text();
    throw new Error(`Failed to add secret version for '${name}': ${versionRes.status} ${err}`);
  }
}

/**
 * Rotate a secret (add a new version). Agents pick up on next secret-read.
 */
export async function rotateSecret(name: string, value: string): Promise<void> {
  const h = await headers();
  const res = await fetch(`${baseUrl()}/secrets/${smName(name)}:addVersion`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      payload: { data: Buffer.from(value).toString("base64") },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to rotate secret '${name}': ${res.status} ${err}`);
  }
}

/**
 * Delete a secret and all its versions.
 */
export async function deleteSecret(name: string): Promise<void> {
  const h = await headers();
  const res = await fetch(`${baseUrl()}/secrets/${smName(name)}`, {
    method: "DELETE",
    headers: h,
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Failed to delete secret '${name}': ${res.status} ${err}`);
  }
}

/**
 * Grant secretAccessor role on a specific secret to a service account.
 */
export async function grantSecretAccess(name: string, serviceAccountEmail: string): Promise<void> {
  const h = await headers();
  const resource = `${baseUrl()}/secrets/${smName(name)}`;

  // Get current IAM policy
  const getRes = await fetch(`${resource}:getIamPolicy`, { headers: h });
  if (!getRes.ok) {
    const err = await getRes.text();
    throw new Error(`Failed to get IAM policy for secret '${name}': ${getRes.status} ${err}`);
  }

  const policy = await getRes.json();
  const member = `serviceAccount:${serviceAccountEmail}`;
  const role = "roles/secretmanager.secretAccessor";

  // Add binding (or append member to existing binding)
  const bindings = policy.bindings || [];
  const existing = bindings.find((b: { role: string }) => b.role === role);
  if (existing) {
    if (!existing.members.includes(member)) {
      existing.members.push(member);
    }
  } else {
    bindings.push({ role, members: [member] });
  }

  // Set updated policy
  const setRes = await fetch(`${resource}:setIamPolicy`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      policy: { ...policy, bindings },
    }),
  });

  if (!setRes.ok) {
    const err = await setRes.text();
    throw new Error(`Failed to set IAM policy for secret '${name}': ${setRes.status} ${err}`);
  }
}

/**
 * Revoke secretAccessor role on a specific secret from a service account.
 */
export async function revokeSecretAccess(name: string, serviceAccountEmail: string): Promise<void> {
  const h = await headers();
  const resource = `${baseUrl()}/secrets/${smName(name)}`;

  // Get current IAM policy
  const getRes = await fetch(`${resource}:getIamPolicy`, { headers: h });
  if (!getRes.ok) {
    const err = await getRes.text();
    throw new Error(`Failed to get IAM policy for secret '${name}': ${getRes.status} ${err}`);
  }

  const policy = await getRes.json();
  const member = `serviceAccount:${serviceAccountEmail}`;
  const role = "roles/secretmanager.secretAccessor";

  // Remove member from binding
  const bindings = (policy.bindings || []).map((b: { role: string; members: string[] }) => {
    if (b.role === role) {
      return { ...b, members: b.members.filter((m: string) => m !== member) };
    }
    return b;
  }).filter((b: { members: string[] }) => b.members.length > 0);

  // Set updated policy
  const setRes = await fetch(`${resource}:setIamPolicy`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      policy: { ...policy, bindings },
    }),
  });

  if (!setRes.ok) {
    const err = await setRes.text();
    throw new Error(`Failed to revoke IAM for secret '${name}': ${setRes.status} ${err}`);
  }
}

/**
 * Derive service account email from agent name and project ID.
 * Convention: fleet-{agentName}@{projectId}.iam.gserviceaccount.com
 * Must match the SA created by fleet-deploy (corekit/fleet/fleet-deploy).
 */
export function deriveServiceAccount(agentName: string): string {
  return `fleet-${agentName}@${projectId()}.iam.gserviceaccount.com`;
}

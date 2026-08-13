# Web Domains — connect a custom domain to a Firebase Hosting site

Point a custom domain (an apex like `example.com`, or a subdomain like `www.example.com`)
at a Firebase Hosting **site** by registering it with Firebase and giving the operator the
**exact DNS records** to create. This skill is **DNS-provider-agnostic**: you never edit DNS
yourself — you produce the records, the operator applies them at whatever provider hosts the
base domain (AWS Route 53, Cloudflare, Google Cloud DNS, GoDaddy, …), and then you verify.

## When to use
A website surface is already live on `SITE.web.app` and needs to answer on a real domain.
Use this to discover *what the operator must add to DNS*, hand it over, and confirm the
domain goes live. Deploying the site's content is the `firebase` skill — this skill is only
the domain/DNS layer on top of an already-deployed site.

## Mental model (who does what)
1. **You register** the custom domain with the Hosting site (`domain-connect add`).
2. **Firebase returns the required DNS records** — an ownership `TXT` record plus one or more
   serving records (`A`/`AAAA` for an apex; `A` or `CNAME` for a subdomain). You read them
   back verbatim. **Never hardcode IPs** — Firebase's anycast addresses can change; always use
   what the API returns right now.
3. **You hand those records to the operator** as a clean list. Their DNS admin creates them in
   the provider that hosts the base domain. You have no DNS credentials and don't need any.
4. **The operator applies the records** (out of band).
5. **You verify** (`domain-connect status`) until Firebase reports the domain active and its
   TLS certificate provisioned. Then the site answers on the custom domain over HTTPS.

## The tool: `domain-connect`
```
domain-connect add    --project PROJECT --site SITE --domain DOMAIN
domain-connect status --project PROJECT --site SITE --domain DOMAIN
domain-connect remove --project PROJECT --site SITE --domain DOMAIN
```
- `PROJECT` — the Firebase/GCP project that owns the Hosting site.
- `SITE` — the Hosting site id (the `SITE` in `SITE.web.app`).
- `DOMAIN` — the fully-qualified custom domain (e.g. `www.example.com` or `example.com`).
- Auth is the caller's `gcloud auth print-access-token`; the identity needs
  `roles/firebasehosting.admin` (or Owner/Editor) on `PROJECT`. The tool sends the required
  `X-Goog-User-Project: PROJECT` quota header for you.

`add` is idempotent (a domain already registered just re-reports its state). Both `add` and
`status` print the current state plus the DNS records still to add. Under the hood it calls
the Firebase Hosting `customDomains` REST API (`firebasehosting.googleapis.com/v1beta1`) with
`curl`; you can call that API directly if you need a field the tool doesn't surface.

## Procedure
1. **Confirm the target** — the `PROJECT`, `SITE`, and exact `DOMAIN`. Apex and subdomain both
   work; the records differ and the API tells you which.
2. **Register + read the records:**
   ```bash
   domain-connect add --project YOUR_PROJECT --site YOUR_SITE --domain sub.example.com
   ```
   It prints a table like:
   ```
   TYPE    HOST / NAME                     VALUE
   TXT     sub.example.com                 hosting-site=...        (ownership)
   A       sub.example.com                 <firebase-anycast-ip>
   A       sub.example.com                 <firebase-anycast-ip>
   ```
3. **Hand the records to the operator.** Present the table plainly and say where they go:
   *"Create these record sets in the DNS zone for the base domain (`example.com`)."* Give the
   type, host/name, and value for each row. The record data is universal — don't dictate
   provider-specific clicks unless asked.
   - **AWS Route 53 mapping:** each row → a record in the base domain's Hosted Zone.
     `TYPE`→Record type, `HOST / NAME`→Record name, `VALUE`→Value. For an apex `A` with
     Firebase IPs, create a **plain A record** with the given values (not an Alias); multiple
     `A` values go in one record set, one per line. TTL 3600 is fine.
4. **Wait for the operator** to confirm the records exist (DNS can take minutes to propagate).
5. **Verify:**
   ```bash
   domain-connect status --project YOUR_PROJECT --site YOUR_SITE --domain sub.example.com
   ```
   Repeat until it reports `✅ LIVE` (host active, ownership active, certificate provisioned)
   with no records remaining, then confirm over HTTPS:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://sub.example.com/
   ```

## Record types you will see
- **TXT (ownership).** Proves you control the domain; must exist before Firebase will serve.
- **A / AAAA (serving).** Firebase's anycast IPs. An apex (`example.com`) uses `A` (and
  `AAAA`) records; a subdomain may use `A` records or a single `CNAME` — use whatever the API
  returns.
- **CNAME (subdomain serving).** If returned, the subdomain is aliased to a Firebase target; a
  `CNAME` cannot coexist with other records on the same name.

## Error recovery
| Symptom | Cause → Fix |
|---|---|
| `403` / `PERMISSION_DENIED` on register | Quota project or IAM. The tool already sends `X-Goog-User-Project`; ensure the identity has `roles/firebasehosting.admin` on `PROJECT`. |
| `already exists` on `add` | Fine — already registered; the tool re-reports current state. |
| `status` shows `ownershipState` not active | The `TXT` record isn't visible yet. Confirm the operator added it exactly; wait for propagation; re-run `status`. |
| Host active but `certState` not active | The TLS cert is still provisioning after the records resolve (can take up to ~24h). Keep polling `status`. |
| "No required records reported yet" | The API is still computing them; re-run `status` in a minute. |
| A subdomain won't verify with a `CNAME` | That name probably has other records (e.g. a leftover `A`); a `CNAME` must be the only record on its name. Remove the conflicts. |

## Boundaries
- You provide records and verify — you never edit the operator's DNS. If a project instead
  wants Firebase to manage DNS **directly** via Google Cloud DNS, that's a separate setup
  requiring `roles/dns.admin` on the DNS project — out of scope here.
- One site can serve multiple custom domains; register each with its own `add`.

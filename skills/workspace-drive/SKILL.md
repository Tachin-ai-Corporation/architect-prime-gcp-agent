# Skill: Google Drive

> **Note:** Google Drive is the **secondary export substrate** for stakeholder-facing
> deliverables. The canonical version of all artifacts lives in the project's git
> repo (C-24). Use `work-publish` to render/export human-readable deliverables.

## When to Use
When a task involves files in Google Drive — listing, searching, downloading, uploading, organizing, or sharing.

## Commands

### Read
- `drive-ls [FOLDER_ID] [--max 20]` — List files and subfolders in a folder. If FOLDER_ID is omitted, lists the root folder.
  Output: JSON array of file metadata including `id`, `name`, `type` (short label), `modified`, and `link`.
- `drive-search --query "QUERY" [--order-by "KEY desc"] [--max N]` — Search for files using a Google Drive API search query.
  Output: JSON array of file metadata — each entry: `id`, `name`, `type` (short label: `doc`/`sheet`/`slides`/`folder`/`pdf`, else the raw MIME), `owner`, `created`, `modified`, `shared` (when it was shared with this account), `link`.
  `--order-by` controls the sort (default `modifiedTime desc`). **Choose the sort that fits the request — don't default blindly.** Useful keys: `modifiedTime`, `createdTime`, `sharedWithMeTime`, `viewedByMeTime`, `name`, `recency` (append ` desc` for newest-first).
  Common queries (combine with `and`):
  - `name contains 'report'`
  - `fullText contains 'quarterly budget'` (search inside file contents)
  - `sharedWithMe = true` (files shared with the agent's Workspace account)
  - `sharedWithMe = true and name contains 'contract'`
  - `'<folderId>' in parents` (files inside a specific folder)
  - `mimeType = 'application/vnd.google-apps.document'` (Google Docs only)

  **Date filtering vs. sorting** — the query can *filter* on `modifiedTime`, `createdTime`, `viewedByMeTime` (operators `<  <=  =  >  >=`, RFC 3339, e.g. `modifiedTime > '2026-05-01T00:00:00'`). `sharedWithMeTime` is different: it can be **sorted** via `--order-by` and is **returned** as `shared`, but it **cannot** be used as a query filter — sort by it and read the `shared` values instead (see "Find files someone shared with you" below).

  **Bound the result set.** Default `--max` is 20. Pass `--max N` to fetch only what you need — a smaller result returns faster and is easier to work with. When the user asks for "the N most recent / latest / top" of something, pass `--max N` (e.g. "3 most recent shared docs" → `--max 3`); don't pull a large list and slice it mentally.
  **One search per result set.** A single `drive-search` returns the complete set for its query — if results came back, use them; do **not** re-issue the same command expecting more to appear. To get a different result, change `--query`, `--order-by`, or `--max`.
- `drive-download FILE_ID [--output PATH] [--force]` — Download a binary file from Google Drive to a local path.
  Output: `status` (`downloaded` | `cached`), `path`, `name`, `mimeType`, and a `readWith` hint naming the tool that can actually read what you fetched.
  **Idempotent**: if the target path already holds the same bytes (md5 match) it returns `cached` and skips the fetch. Never download the same file twice under a second name — re-run the same command and read the `status`. Pass `--force` only when you need to refetch changed content.
- `drive-to-doc --file FILE_ID_OR_PATH [--name TITLE] [--folder FOLDER_ID] [--ocr-lang en] [--force]` — Convert a PDF or image into a **readable Google Doc** (Drive runs OCR during conversion). Accepts a Drive file ID or a local path.
  Output: `status` (`converted` | `cached` | `already_doc`), `docId`, `readWith` (`docs-cat <docId>`), `cleanupWith` (`drive-delete <docId>`).
  The original file is never modified — this creates a readable copy. Idempotent: a prior conversion with the same derived name is reused unless `--force`.
- `drive-download-folder FOLDER_ID [--output /path/to/dir]` — Recursively download an entire folder, preserving directory structure.
  Google Workspace docs are exported as PDF. Max depth: 10 levels.
  Output: JSON summary with file/folder counts and output directory.

### Publish (Preferred for Artifacts)
- `work-publish FILE [--project PROJECT_ID] [--subfolder NAME]` — **Standard artifact publisher.** Automatically resolves the correct Drive folder and creates date-based subfolders.
  - **Project mode**: `work-publish report.pdf --project your-website-project` → uploads to `{project}/MM-DD/report.pdf`
  - **Agent mode**: `work-publish notes.md` → uploads to `{prime}/{agent}/MM-DD/notes.md`
  - **Custom subfolder**: `work-publish logo.svg --project your-website-project --subfolder assets` → uploads to `{project}/assets/logo.svg`
  - Output: JSON with `status`, `fileId`, `folderId`, `folderPath`, `webViewLink`.
  - All folder creation is idempotent — safe to run repeatedly.

> ⚠️ **IMPORTANT**: Use `work-publish` instead of `drive-upload` when publishing work products or artifacts. `work-publish` enforces the standard folder hierarchy. Use `drive-upload` only for edge cases where you need direct folder control.

### Write
- `drive-upload PATH [--name NAME] [--folder FOLDER_ID]` — Upload a local file to a specific Drive folder. For artifact publishing, prefer `work-publish` instead.
  Output: Uploaded file metadata including the newly created `id`.
- `drive-mkdir --name NAME [--parent PARENT_ID]` — Create a new folder inside Google Drive.
  Output: Created folder metadata.
- `drive-rename FILE_ID --name NEW_NAME` — Rename an existing file or folder.
  Output: Success confirmation.
- `drive-delete FILE_ID` — Trash an existing file or folder.
  Output: Success confirmation.
- `drive-move FILE_ID --to FOLDER_ID` — Move a file or folder into a different folder.
  Output: Success status.
- `drive-share FILE_ID --to EMAIL --role ROLE` — Share a file/folder with a user or domain. ROLE is `reader`, `writer`, or `commenter`. Use `anyone` for public link sharing.
  Output: Success status.


## Procedures

### Find files someone shared with you
The agent's Workspace account has its own Drive. When a user says "the doc I shared with you," they mean a file in the **shared-with-me** set (`sharedWithMe = true`). Three time fields matter — pick the one the request is really about:
- `shared` (`sharedWithMeTime`) — when the file landed in *your* shared list. This is the axis for "recently shared" / "shared last month." Sortable and returned; **not** query-filterable.
- `modified` (`modifiedTime`) — when the content last changed (often long before it was shared with you). Query-filterable.
- `created` (`createdTime`) — when the file was first created. Query-filterable.

Don't assume — read what the user asked for and choose the field + sort accordingly.

**"I just shared a doc about X" / "my N most recent shared docs" → sort by share time:**
1. `drive-search --query "sharedWithMe = true and name contains 'X'" --order-by "sharedWithMeTime desc" --max 5`
   (drop `name contains` for a bare "most recent shared"; use `fullText contains 'X'` if the topic is in the body, not the title; **set `--max` to how many you need** — "3 most recent" → `--max 3`).
2. The top results are the most-recently-shared matches. Confirm with each `shared` timestamp and `owner`, then act on the `id` (e.g. `docs-cat <id>` for a Google Doc). One search returns the full set — format what came back; don't re-run it.

**"Find something I shared with you 1–2 months ago" → a shared-time window:**
`sharedWithMeTime` can't be filtered in the query, so sort by it and scan the results:
1. `drive-search --query "sharedWithMe = true" --order-by "sharedWithMeTime desc" --max 50` (add `and name contains '...'` / `fullText contains '...'` if you know the topic — it narrows the list).
2. Compute the target window from today's date, then pick the entries whose `shared` value falls inside it. Results are newest-shared-first, so the target sits a little way down the list.
3. If the window isn't reached, raise `--max` and scan further.

**Who shared it:** the `owner` field on each result shows the file's owner — use it to confirm the file came from the expected person.

### Find a file by name and download it
1. Run `drive-search --query "name contains '<filename>'"` to retrieve matching files.
2. If no results, run `drive-search --query "fullText contains '<filename>'"` to search within file contents.
3. If multiple files return, examine `type` and `modified` to find the correct file.
4. **CRITICAL: Check the `type` before proceeding!**
   - `doc` (Google Doc) → **do not use `drive-download`**. Use `docs-cat <FILE_ID>` or `docs-get --doc <FILE_ID>` (from the `workspace-docs` skill).
   - `sheet` (Google Sheet) → use the appropriate `workspace-sheets` tools.
   - `slides` (Google Slides) → use the `workspace-slides` tools.
   - `pdf` or an image → **you want its text, not its bytes**: `drive-to-doc --file <FILE_ID>` then `docs-cat <docId>`. See "Read a PDF or image" below.
   - Plain text (`text/markdown`, `text/plain`, `application/json`, …) → run `drive-download <FILE_ID> --output /tmp/<filename>`, then `readFile`.
5. Verify: Check that local file size > 0 and file exists.

### Read a PDF or image (text extraction)
A PDF's bytes are not text. `readFile` on a downloaded PDF returns unreadable
bytes, consumes the whole context window, and yields nothing usable — the tool
will refuse it and point you back here. Drive can convert, with OCR:

1. `drive-to-doc --file <FILE_ID>` — works on a Drive file ID *or* a local path
   (so an already-downloaded PDF is fine). Returns a `docId`.
2. `docs-cat <docId>` — read the extracted text (from the `workspace-docs` skill).
3. `drive-delete <docId>` — trash the converted copy once you have what you need.
   The original is never touched.

**Do not conclude that a PDF is unreadable.** If step 1 fails, read its error:
a 403 means the file needs sharing with the agent's account, a 404 means the ID
is wrong. Both are resolvable. Scanned documents may OCR imperfectly — pass
`--ocr-lang <BCP-47>` for non-English text, and if a specific field is genuinely
illegible, ask for that one field rather than abandoning the task.

### Download an entire folder recursively
1. Run `drive-download-folder FOLDER_ID --output /path/to/local/dir` to download all files and subfolders.
2. The script preserves directory structure, handles Google Workspace doc export (→ PDF), and limits recursion to 10 levels.
3. Verify: Check the JSON summary output for `files`, `folders`, and `failed` counts.
4. *Alternative (manual)*: If you need selective downloads, use `drive-ls FOLDER_ID` to list children, then `drive-download` each file individually.

> ⚠️ **IMPORTANT**: When downloading multiple files, always download them **one at a time** (sequentially). Never issue parallel `drive-download` tool calls — the gateway cannot handle multiple simultaneous tool responses and will crash with a 400 error.

### Edit a file from Drive
When you need to modify a file that lives in Google Drive:
This procedure is for **text** files (markdown, plain text, JSON, CSV). A PDF,
image, or Office file cannot be edited this way — convert or use its own skill.

1. Run `drive-ls FOLDER_ID` to find the file's ID.
2. Run `drive-download FILE_ID --output /path/to/local/file` to download it.
3. Run `readFile` on the downloaded file to load its contents into context.
4. Apply your modifications to the content.
5. Run `writeFile` with the COMPLETE modified content to save the file locally.
   - Write the ENTIRE file, not a diff or snippet.
   - This step is MANDATORY. Without `writeFile`, you are uploading the original unmodified file.
6. Run `drive-upload /path/to/local/file --folder FOLDER_ID` to upload the modified version.
7. Verify: Run `drive-ls FOLDER_ID` to confirm the file was updated.

> ⚠️ **Common mistake**: Downloading a file and uploading it without calling `writeFile` in between. This uploads the original, unmodified file. The `writeFile` call between download and upload is what saves your modifications.

### Upload a file to a specific folder
1. Run `drive-search --query "name contains '<folderName>' and mimeType = 'application/vnd.google-apps.folder'"` to get the folder's ID.
2. If the folder does not exist, run `drive-mkdir --name '<folderName>'` to create it and use the returned ID.
3. Run `drive-upload /path/to/file --name '<targetName>' --folder <FOLDER_ID>`.
4. Verify: Ensure the output confirms success and returns a valid file ID.

### Move or rename a file
1. Run `drive-search` to resolve the target file's ID.
2. If moving the file, resolve the destination folder ID using `drive-search`. Then run `drive-move <FILE_ID> --to <FOLDER_ID>`.
3. If renaming the file, run `drive-rename <FILE_ID> --name '<NEW_NAME>'`.
4. Verify: Run `drive-ls <FOLDER_ID>` or check response messages to confirm the change.

### Share a file with a teammate
1. Resolve the file's ID.
2. Run `drive-share <FILE_ID> --to <user_email> --role writer` (or `reader` for read-only access).
3. Verify: Confirm the API output shows success.

## Sync Service Integration

The `your-website-project` project uses a sync-service that automatically propagates files from Google Drive to GCS and Firebase Hosting. Key rules:

- **Root files are ignored**: The sync-service only syncs files in **subdirectories** (e.g., `public/`, `images/`). Files placed directly in the root Drive folder are skipped by design.
- **Latency**: Changes take ~60-90 seconds to propagate (Drive notification delay + Cloud Run cold start).
- **Public folder**: For files intended for the live website, upload to the `public/` subfolder within the root website folder.
- **Verification**: After uploading, wait 90 seconds then check `gsutil ls gs://your-website-assets/public/<filename>` to confirm sync.

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account lacks access permissions | Ask the user to share the file or folder with the agent's Workspace email address (shown in the error response). |
| `404 notFound` | Invalid file/folder ID, or it has been deleted | Run `drive-search` with a name-based query to find the correct, active ID. |
| `429 rateLimitExceeded` | Too many API requests | Wait 30 seconds, then retry the command once. |
| Search returns empty | Query filter too narrow | Broaden the search by removing mimeType restrictions or searching partial names. |
| Download fails on Google Doc | Attempting binary download of a Google native doc | Use the specific reader tool (e.g., `docs-cat` for Docs, sheet tools for Sheets) rather than `drive-download`. |
| `readFile` refuses the file: "is PDF, not text" | A PDF/image was downloaded and read directly — its bytes aren't characters | `drive-to-doc --file <path or id>` → `docs-cat <docId>`. This is a routing problem, not a missing capability. |
| Downloaded the same file twice under different names | Re-ran a download after a timeout or retry without checking state | `drive-download` is idempotent — re-run the *same* `--output` path and read `status` (`cached` means the bytes are already there). |
| OCR text is garbled or partial | Scanned/low-quality source, or wrong OCR language | Re-run `drive-to-doc --force --ocr-lang <BCP-47>`. If one field is still illegible, ask for that field alone — don't abandon the task. |
| File uploaded to Drive but not syncing to GCS | File is in the root folder | Move the file to a subdirectory (e.g., `public/`). The sync-service ignores root-level files by design. |

## Examples

### Example: Search and download a PDF report
```
Task: "Get the Q3 marketing PDF report and download it locally."

Step 1: drive-search --query "name contains 'Q3' and name contains 'marketing' and mimeType = 'application/pdf'"
→ Result: [{ "id": "1A2B3C_pdf_id", "name": "Q3 Marketing Report.pdf", "type": "pdf" }]

Step 2: drive-download 1A2B3C_pdf_id --output /tmp/Q3_Marketing_Report.pdf
→ Result: Downloaded 4.8MB to /tmp/Q3_Marketing_Report.pdf

Outcome: File found and downloaded to /tmp/Q3_Marketing_Report.pdf.
```

### Example: Create a folder and upload a slide deck
```
Task: "Upload our local slide deck to the 'Presentation Drafts' folder."

Step 1: drive-search --query "name contains 'Presentation Drafts' and mimeType = 'application/vnd.google-apps.folder'"
→ Result: [] (not found)

Step 2: drive-mkdir --name "Presentation Drafts"
→ Result: { "id": "9Z8Y7X_folder_id", "name": "Presentation Drafts", "mimeType": "application/vnd.google-apps.folder" }

Step 3: drive-upload /tmp/deck.pptx --name "Q3 Pitch Deck.pptx" --folder 9Z8Y7X_folder_id
→ Result: { "id": "4D5E6F_file_id", "name": "Q3 Pitch Deck.pptx" }

Outcome: Folder created and file uploaded successfully.
```

### Example: Find a doc someone just shared with you
```
Task: "I just shared a contract draft with you — pull it up."

Step 1: drive-search --query "sharedWithMe = true and name contains 'contract'" --order-by "sharedWithMeTime desc"
→ Result: [{ "id": "1AbC...", "name": "Acme Contract Draft", "owner": "teammate@example.com",
             "shared": "2026-07-22T14:03:00Z", "modified": "2026-07-10T09:12:00Z", "link": "..." }]

Step 2: docs-cat 1AbC...   # Google Doc → use the Docs reader, not drive-download

Outcome: Most-recently-shared match found by ordering on sharedWithMeTime. Note `shared` is newer
than `modified` — sorting on modifiedTime would have buried it. Opened with the Docs reader.
```

---

### Edit a file sourced from a URL
When the file to modify lives at a public URL rather than in Drive:
1. Run `web-fetch --url "<url>" --format html` (from the `web-search` skill) to retrieve the source. Use the default `text` format only when you need readable text rather than markup.
2. Apply your modifications to the content.
3. Run `writeFile` with the COMPLETE modified content to save the file locally — the entire document, not a diff or snippet. Without `writeFile`, there is nothing to upload.
4. Run `work-publish /path/to/local/file --project <PROJECT_ID>` to publish it (or `drive-upload /path/to/local/file --folder <FOLDER_ID>` when a specific folder is required).
5. Verify: confirm the output returns a valid file ID.

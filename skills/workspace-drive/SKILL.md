# Skill: Google Drive

## When to Use
When a task involves files in Google Drive — listing, searching, downloading, uploading, organizing, or sharing.

## Commands

### Read
- `drive-ls [FOLDER_ID] [--max 20]` — List files and subfolders in a folder. If FOLDER_ID is omitted, lists the root folder.
  Output: JSON array of file metadata including `id`, `name`, `mimeType`, and `modifiedTime`.
- `drive-search --query "QUERY"` — Search for files using a Google Drive API search query.
  Output: JSON array of matching file metadata.
  Common queries:
  - `name contains 'report'`
  - `sharedWithMe=true` (files shared with the agent's Workspace account)
  - `'<folderId>' in parents` (files inside a specific folder)
- `drive-download FILE_ID [--output PATH]` — Download a binary file from Google Drive to a local path.
  Output: Download confirmation details and local path.

### Write
- `drive-upload PATH [--name NAME] [--folder FOLDER_ID]` — Upload a local file to a Google Drive folder.
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

### Find a file by name and download it
1. Run `drive-search --query "name contains '<filename>'"` to retrieve matching files.
2. If no results, run `drive-search --query "fullText contains '<filename>'"` to search within file contents.
3. If multiple files return, examine `mimeType` and `modifiedTime` to find the correct file.
4. Run `drive-download <FILE_ID> --output /tmp/<filename>` using the file ID from search.
5. Verify: Check that local file size > 0 and file exists.
   *Note: For Google native documents (Docs, Sheets, Slides), do not download them; read their content directly using their respective specialty tools (e.g. `docs-cat` or sheet read scripts).*

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

## Error Recovery

| Error / Symptom | Likely Cause | Recovery |
|-----------------|-------------|----------|
| `403 forbidden` | Service account lacks access permissions | Ask the user to share the file or folder with the agent's Workspace email address (shown in the error response). |
| `404 notFound` | Invalid file/folder ID, or it has been deleted | Run `drive-search` with a name-based query to find the correct, active ID. |
| `429 rateLimitExceeded` | Too many API requests | Wait 30 seconds, then retry the command once. |
| Search returns empty | Query filter too narrow | Broaden the search by removing mimeType restrictions or searching partial names. |
| Download fails on Google Doc | Attempting binary download of a Google native doc | Use the specific reader tool (e.g., `docs-cat` for Docs, sheet tools for Sheets) rather than `drive-download`. |

## Examples

### Example: Search and download a PDF report
```
Task: "Get the Q3 marketing PDF report and download it locally."

Step 1: drive-search --query "name contains 'Q3' and name contains 'marketing' and mimeType = 'application/pdf'"
→ Result: [{ "id": "1A2B3C_pdf_id", "name": "Q3 Marketing Report.pdf", "mimeType": "application/pdf" }]

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

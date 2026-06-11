# Skill: Google Drive

## What this skill does
Interact with Google Drive — list, search, download, upload, create folders,
rename, move, delete, and share files. Works with files shared with your
Workspace email by human users.

## When to use
- User asks about files in their Drive or shared files
- Task requires organizing, moving, or creating files
- User shares a Drive link and wants you to work with it
- Need to upload or download documents

## Tools (ALL dispatched to motor)

### Read
- `drive-ls [FOLDER_ID] [--max 20]` — list files in a folder
- `drive-search --query "name contains 'report'"` — search files
- `drive-search --query "sharedWithMe=true"` — list files shared with you
- `drive-download FILE_ID [--output /path]` — download a file

### Write
- `drive-upload /path/to/file [--name "Name"] [--folder FOLDER_ID]` — upload a file
- `drive-mkdir --name "Name" [--parent ID]` — create a folder
- `drive-rename FILE_ID --name "New Name"` — rename a file
- `drive-delete FILE_ID` — trash a file
- `drive-move FILE_ID --to FOLDER_ID` — move a file
- `drive-share FILE_ID --to anyone --role reader` — share a file

## Access & Sharing
- Files shared with your Workspace email are automatically visible.
- If you get an access_denied error, ask the user to share the file
  with your email address (shown in the error response).
- Files you create are owned by you. Share them with users who need access.

## Auth
All tools authenticate via DWD (Domain-Wide Delegation) using the agent's
Workspace email. No API keys or OAuth tokens needed.

## Shared Workspace Auto-Publishing
Files written to `shared/{missionId}/` during mission execution are
automatically published to Drive by brain on mission completion. Motor
does NOT need to manually `drive-upload` these files. Use `drive-upload`
only for files outside the shared workspace or when uploading to a
specific Drive location requested by the user.

import functions_framework
from google.cloud import storage
import json
import time
import os

# ---- Config ----
BUCKET_NAME = os.environ.get("INBOX_BUCKET", "architect-prime-beta-chat-inbox")
AGENT_ID = os.environ.get("AGENT_ID", "prime")

storage_client = storage.Client()


def generate_ulid():
    """Simple timestamp-based ID (no external dep needed)."""
    ts = int(time.time() * 1000)
    return f"{ts:013d}-{os.urandom(4).hex()}"


def write_to_inbox(agent_id, message_data):
    """Write a message JSON to the agent's GCS inbox."""
    bucket = storage_client.bucket(BUCKET_NAME)
    msg_id = generate_ulid()
    blob = bucket.blob(f"{agent_id}/pending/{msg_id}.json")
    blob.upload_from_string(
        json.dumps(message_data, indent=2),
        content_type="application/json"
    )
    return msg_id


@functions_framework.http
def handle_chat_event(request):
    """HTTP Cloud Function that receives Google Chat events.

    Routes messages to the correct agent's GCS inbox.
    Returns an immediate acknowledgment to Chat.
    """
    event = request.get_json(silent=True)
    if not event:
        return json.dumps({"text": "No event data received."}), 200

    event_type = event.get("type", "")
    space = event.get("space", {})
    space_name = space.get("name", "")
    user = event.get("user", {})
    user_name = user.get("displayName", "Unknown")

    # ---- ADDED_TO_SPACE ----
    if event_type == "ADDED_TO_SPACE":
        write_to_inbox(AGENT_ID, {
            "type": "ADDED_TO_SPACE",
            "space": space_name,
            "user": user_name,
            "timestamp": time.time()
        })
        return json.dumps({
            "text": f"👋 Hello! I'm *Architect Prime*. I'll process your requests and respond shortly.\n\nCommands: `help`, `status`, `fleet`"
        })

    # ---- MESSAGE ----
    if event_type == "MESSAGE":
        message = event.get("message", {})
        text = message.get("argumentText", message.get("text", "")).strip()
        msg_name = message.get("name", "")
        thread_name = message.get("thread", {}).get("name", "")

        # Determine target agent from message text
        # Default to prime; fleet routing added in v0.7.0+
        target_agent = AGENT_ID

        msg_data = {
            "type": "MESSAGE",
            "text": text,
            "sender": user_name,
            "senderEmail": user.get("email", ""),
            "space": space_name,
            "messageName": msg_name,
            "threadName": thread_name,
            "timestamp": time.time()
        }

        msg_id = write_to_inbox(target_agent, msg_data)

        return json.dumps({
            "text": f"⏳ Processing: _{text}_\n`msg:{msg_id}`"
        })

    # ---- REMOVED_FROM_SPACE ----
    if event_type == "REMOVED_FROM_SPACE":
        write_to_inbox(AGENT_ID, {
            "type": "REMOVED_FROM_SPACE",
            "space": space_name,
            "timestamp": time.time()
        })
        return json.dumps({})

    # ---- Unknown event ----
    return json.dumps({"text": f"Unknown event type: {event_type}"}), 200

# Skill: Vertex AI Grounding Search

## When to Use
When the task requires fetching real-time information or search results from the web, or retrieving raw text content from a specific URL.

## Commands

### Read
- `web-search "<question>"` — Search Google with Vertex AI grounding to get real-time answers.
  Output: Grounded answer with search citations and source URLs.
- `web-fetch --url "<url>" [--format text|html] [--max <bytes>] [--timeout <seconds>]` — Extract content from a specific web page. Default format is `text` (readable). Use `html` for raw markup.
  Output: Extracted text or HTML content of the page.

## Important Notes
- **Read-Only:** This is a read-only skill — it does not modify any state or infrastructure.
- **Routing:** Do not call `web-search` directly from Cortex; always route research through a `temporal-research` sub-agent.

## Procedures

### Research a current topic
1. Define the specific question or topic of interest.
2. Run `web-search "<question>"` to fetch real-time information.
3. Verify: Ensure the output contains grounded answers and includes source citations.

### Extract documentation or article details
1. Run `web-search "<topic>"` to discover the relevant URL, or start with a known URL.
2. Run `web-fetch --url "<url>"` to retrieve the webpage contents.
3. Verify: Check that the output contains the page text, rather than navigation headers or error pages.

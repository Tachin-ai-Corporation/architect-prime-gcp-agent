# TOOLS — Temporal

## Memory Tools

### Search working memory (OpenClaw native)
```
memory_search "<query>"
```
Searches daily notes + MEMORY.md via hybrid index (keyword + semantic).

### Read specific memory file
```
memory_get <path>
```

### Search long-term memory (Vertex AI Memory Bank)
```
memorybank_search "<query>"
```

### Read core memory (Firestore)
```
exec core-memory-read --category <category> --query "<search terms>"
```
Categories: architecture, operations, iam, decisions, patterns, errors

## Research Tools

### Web search (Google Search grounding)
```
exec web-search "<query>"
```

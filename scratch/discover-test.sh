#!/usr/bin/env bash
set -euo pipefail

# Dump one Gemini model's full structure to understand the schema
gcloud ai model-garden models list --format=json --project=architect-prime-beta 2>/dev/null | python3 -c "
import json, sys

data = json.load(sys.stdin)
print(f'Total: {len(data)}')

# Find LLM-like models by known publisher patterns
llm_publishers = ['google', 'anthropic', 'meta', 'mistral-ai', 'cohere']
text_keywords = ['gemini', 'claude', 'llama', 'mistral', 'codey', 'palm', 'text-bison', 'chat-bison']

# Filter for likely text LLMs
llms = []
for m in data:
    name = m.get('name', '').lower()
    # Skip image/video/audio/embedding models
    if any(x in name for x in ['image', 'video', 'audio', 'segment', 'detect', 'embed', 'vision', 'clip', 'vit', 'stable-diff', 'pix2pix', 'bert', 'efficientnet', 'owl', 'blip', 'control-net', 'deeplab', 'yolo', 'resnet', 'occupancy', 'vehicle', 'language-v1', 'chirp', 'imagebind', 'multimodal']):
        continue
    # Match known LLM patterns
    if any(x in name for x in text_keywords):
        llms.append(m)
        continue
    # Check supported actions for 'generateContent' or chat-like
    actions = str(m.get('supportedActions', {}))
    if 'openGenerationAiStudio' in actions or 'openNotebook' in actions:
        # Could be a gen model
        publisher = name.split('/')[1] if '/' in name else ''
        if publisher in llm_publishers:
            llms.append(m)

print(f'Likely text LLMs: {len(llms)}')
for m in llms:
    name = m.get('name', '?')
    actions = m.get('supportedActions', {})
    open_studio = 'openGenerationAiStudio' in actions
    print(f'  {name}  studio={open_studio}')

# Also dump the full structure of one Gemini model
for m in data:
    if 'gemini-2.5-pro' in m.get('name', ''):
        print(f'\n=== Full structure of gemini-2.5-pro ===')
        print(json.dumps(m, indent=2)[:2000])
        break
"

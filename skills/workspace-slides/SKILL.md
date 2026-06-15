# Skill: Google Slides

## What this skill does
Create, read, edit, and manage Google Slides presentations.

## When to use
When creating, reading, or editing Google Slides presentations — layouts, text, images, shapes, formatting.

## Tools (dispatched to motor for writes, motor for reads)

### Read
- `slides-get <presentation_id> [--slide INDEX]` — read presentation metadata and slide summary

### Write
- `slides-create --title "Name" [--folder FOLDER_ID]` — create a new presentation
- `slides-update <presentation_id> --requests '<JSON array>'` — batch update (generic workhorse)
- `slides-add-slide <presentation_id> [--layout LAYOUT_TYPE] [--index INSERT_INDEX]` — add a new slide
- `slides-duplicate <presentation_id> --slide-id <SLIDE_OBJECT_ID>` — duplicate a slide

## Tool Details

### slides-create
Create a new empty presentation.
```
slides-create --title "Q3 Report" --folder 1abc2def3ghi
```
**Args:**
| Arg | Required | Description |
|-----|----------|-------------|
| `--title` | Yes | Presentation title |
| `--folder` | No | Google Drive folder ID to move into |

**Output:** `{"status":"created","presentationId":"...","title":"...","link":"https://docs.google.com/presentation/d/..."}`

### slides-get
Read presentation content and slide structure.
```
slides-get 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
slides-get 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms --slide 0
```
**Args:**
| Arg | Required | Description |
|-----|----------|-------------|
| `<presentation_id>` | Yes | Presentation ID (positional) |
| `--slide` | No | 0-indexed slide number to show |

**Output:** JSON with presentationId, title, slideCount, and slides array (objectId, pageElements count, layout).

### slides-update
Generic batch update — the workhorse for all mutations. Pass raw Slides API request objects.
```
slides-update 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms --requests '[{"insertText":{"objectId":"g123","text":"Hello","insertionIndex":0}}]'
```
**Args:**
| Arg | Required | Description |
|-----|----------|-------------|
| `<presentation_id>` | Yes | Presentation ID (positional) |
| `--requests` | Yes | JSON array of Slides API request objects |

**Output:** Full batchUpdate API response.

### slides-add-slide
Add a new slide with a predefined layout.
```
slides-add-slide 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms --layout TITLE_AND_BODY --index 1
```
**Args:**
| Arg | Required | Description |
|-----|----------|-------------|
| `<presentation_id>` | Yes | Presentation ID (positional) |
| `--layout` | No | Layout type (default: BLANK) |
| `--index` | No | 0-indexed insertion position |

**Layout types:** BLANK, TITLE, TITLE_AND_BODY, TITLE_AND_TWO_COLUMNS, TITLE_ONLY, SECTION_HEADER, CAPTION_ONLY, BIG_NUMBER

**Output:** `{"status":"created","slideId":"..."}`

### slides-duplicate
Duplicate an existing slide (copies all elements).
```
slides-duplicate 1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms --slide-id g2f1a3b4c5d
```
**Args:**
| Arg | Required | Description |
|-----|----------|-------------|
| `<presentation_id>` | Yes | Presentation ID (positional) |
| `--slide-id` | Yes | objectId of the slide to duplicate |

**Output:** `{"status":"duplicated","newSlideId":"..."}`

## Common batchUpdate Operations

Use these request objects with `slides-update --requests`. Multiple requests can be combined in a single array.

### insertText — Insert text into a text box
```json
{
  "insertText": {
    "objectId": "TEXTBOX_OBJECT_ID",
    "text": "Hello, world!",
    "insertionIndex": 0
  }
}
```

### createShape — Create rectangles, text boxes, etc.
```json
{
  "createShape": {
    "objectId": "my_textbox_001",
    "shapeType": "TEXT_BOX",
    "elementProperties": {
      "pageObjectId": "SLIDE_OBJECT_ID",
      "size": {
        "width": {"magnitude": 3000000, "unit": "EMU"},
        "height": {"magnitude": 3000000, "unit": "EMU"}
      },
      "transform": {
        "scaleX": 1, "scaleY": 1,
        "translateX": 350000, "translateY": 350000,
        "unit": "EMU"
      }
    }
  }
}
```

### createImage — Insert an image from URL
```json
{
  "createImage": {
    "objectId": "my_image_001",
    "url": "https://example.com/photo.png",
    "elementProperties": {
      "pageObjectId": "SLIDE_OBJECT_ID",
      "size": {
        "width": {"magnitude": 4000000, "unit": "EMU"},
        "height": {"magnitude": 3000000, "unit": "EMU"}
      },
      "transform": {
        "scaleX": 1, "scaleY": 1,
        "translateX": 100000, "translateY": 100000,
        "unit": "EMU"
      }
    }
  }
}
```

### updateTextStyle — Bold, italic, font size, color
```json
{
  "updateTextStyle": {
    "objectId": "TEXTBOX_OBJECT_ID",
    "textRange": {"type": "ALL"},
    "style": {
      "bold": true,
      "italic": false,
      "fontSize": {"magnitude": 18, "unit": "PT"},
      "foregroundColor": {
        "opaqueColor": {"rgbColor": {"red": 0.0, "green": 0.0, "blue": 0.0}}
      }
    },
    "fields": "bold,italic,fontSize,foregroundColor"
  }
}
```

### updateShapeProperties — Fill color, outline, shadow
```json
{
  "updateShapeProperties": {
    "objectId": "SHAPE_OBJECT_ID",
    "shapeProperties": {
      "shapeBackgroundFill": {
        "solidFill": {
          "color": {"rgbColor": {"red": 0.2, "green": 0.5, "blue": 0.9}}
        }
      },
      "outline": {
        "outlineFill": {
          "solidFill": {
            "color": {"rgbColor": {"red": 0.0, "green": 0.0, "blue": 0.0}}
          }
        },
        "weight": {"magnitude": 1, "unit": "PT"}
      }
    },
    "fields": "shapeBackgroundFill.solidFill.color,outline"
  }
}
```

### replaceAllText — Find and replace text across all slides
```json
{
  "replaceAllText": {
    "containsText": {
      "text": "{{PLACEHOLDER}}",
      "matchCase": true
    },
    "replaceText": "Actual Value"
  }
}
```

### updatePageProperties — Background color
```json
{
  "updatePageProperties": {
    "objectId": "SLIDE_OBJECT_ID",
    "pageProperties": {
      "pageBackgroundFill": {
        "solidFill": {
          "color": {"rgbColor": {"red": 0.95, "green": 0.95, "blue": 0.95}}
        }
      }
    },
    "fields": "pageBackgroundFill.solidFill.color"
  }
}
```

### deleteObject — Remove a page element
```json
{
  "deleteObject": {
    "objectId": "ELEMENT_OBJECT_ID"
  }
}
```

## Important Notes
- Extract presentation IDs from Google Slides URLs: the ID is the long string after `/d/`.
- Sizes and positions use EMU (English Metric Units): 1 inch = 914400 EMU, 1 pt = 12700 EMU.
- When combining multiple requests, they execute in array order — create elements before styling them.
- Use `slides-get` first to discover objectIds of existing elements before updating them.

## Auth
All tools authenticate via DWD using the agent's Workspace email.
No API keys or OAuth tokens needed.

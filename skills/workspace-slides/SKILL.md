# Skill: Google Slides

## When to Use
When creating, reading, or editing Google Slides presentations — including creating new slides, updating layouts, inserting text or shapes, and batch-processing formatting requests.

## Commands

### Read
- `slides-get <presentation_id> [--slide INDEX]` — Read presentation metadata and slide layout/structure summary.
  Output: JSON detailing slides, page elements, and layout information.

### Write
- `slides-create --title <title> [--folder FOLDER_ID]` — Create a new empty Google Slides presentation.
  Output: JSON containing the presentation ID and a direct web link.
- `slides-update <presentation_id> --requests <JSON>` — Batch update a presentation using Slides API request objects.
  Output: API batchUpdate response details.
- `slides-add-slide <presentation_id> [--layout LAYOUT_TYPE] [--index INSERT_INDEX]` — Add a new slide with a specific layout.
  Output: Status confirmation and new slide ID.
- `slides-duplicate <presentation_id> --slide-id <SLIDE_OBJECT_ID>` — Duplicate an existing slide page.
  Output: Status confirmation and duplicated slide ID.

## Procedures

### Create a new presentation and add slides
1. Run `slides-create --title "Project Pitch"` to create an empty deck. Note the presentation ID.
2. Run `slides-add-slide <presentation_id> --layout TITLE` to insert the title slide at index 0.
3. Run `slides-add-slide <presentation_id> --layout TITLE_AND_BODY --index 1` to insert a content slide.
4. Verify: Run `slides-get <presentation_id>` and confirm that slideCount is 3 (including the default initial slide).

### Replace text placeholders in a presentation
1. Resolve the presentation ID.
2. Formulate a JSON batch update array containing one or more `replaceAllText` requests (e.g. `[{"replaceAllText":{"containsText":{"text":"{{PROJECT_NAME}}"},"replaceText":"Architect Prime"}}]`).
3. Run `slides-update <presentation_id> --requests '<json_array>'` to apply the updates.
4. Verify: Run `slides-get <presentation_id> --slide 0` or check the presentation manually to confirm replacement.

### Insert text boxes or shapes on a slide
1. Retrieve the presentation ID and target slide's object ID (via `slides-get`).
2. Construct a batch update payload using `createShape` (to create a `TEXT_BOX`) and `insertText`.
3. Run `slides-update <presentation_id> --requests '<json_array>'`.
4. Verify: Confirm the API returns a success response with the new element IDs.

---

## Detailed Tool Reference

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

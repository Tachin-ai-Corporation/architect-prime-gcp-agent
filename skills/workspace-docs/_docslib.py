"""Shared Google Docs helpers for the workspace-docs skill.

Installed to bin/_docslib.py alongside the docs-* scripts. Each script's embedded
python inserts ${CORE_DIR}/bin onto sys.path (via the DOCSLIB_DIR env var its bash
wrapper exports) and imports from here, so the index mapper + tab resolver live in
ONE place and cannot drift. They were previously copy-pasted into 8 scripts, which
is exactly how a systemic index bug survived (startIndex read from the wrong object)
and how an audit mis-cleared it. See reference: gdocs-index-gotcha.
"""


def extract_text_and_map(elements):
    """Return (plain_text, index_map) for a list of Docs structural elements.

    index_map[k] is the TRUE Google Docs API character index of plain_text[k], so
    callers do match_start = index_map[off]; match_end = index_map[off+len-1] + 1.

    CRITICAL: `startIndex` lives on the ParagraphElement (run_elem), NOT the nested
    textRun. Reading it from the textRun yields None -> every char maps to 0 and all
    index-based edits corrupt the doc. Recurses table cells and tableOfContents.
    """
    text = ''
    index_map = []
    for elem in elements:
        if 'paragraph' in elem:
            for run_elem in elem['paragraph'].get('elements', []):
                if 'textRun' in run_elem:
                    content = run_elem['textRun'].get('content', '')
                    start = run_elem.get('startIndex', 0)
                    for i, char in enumerate(content):
                        text += char
                        index_map.append(start + i)
        elif 'table' in elem:
            for row in elem['table'].get('tableRows', []):
                for cell in row.get('tableCells', []):
                    sub_text, sub_map = extract_text_and_map(cell.get('content', []))
                    text += sub_text
                    index_map.extend(sub_map)
        elif 'tableOfContents' in elem:
            sub_text, sub_map = extract_text_and_map(elem['tableOfContents'].get('content', []))
            text += sub_text
            index_map.extend(sub_map)
    return text, index_map


def extract_text_segments(elements):
    """Like extract_text_and_map, but returns (plain_text, segments) where each segment is
    {startIndex, endIndex, text} for one textRun (endIndex exclusive) — ~1/6 the size of a
    per-char index_map, so docs-get's structured output stays under the harness cap instead
    of truncating into invalid JSON. Same ParagraphElement.startIndex source; recurses
    table cells + tableOfContents.
    """
    text = ''
    segments = []
    for elem in elements:
        if 'paragraph' in elem:
            for run_elem in elem['paragraph'].get('elements', []):
                if 'textRun' in run_elem:
                    content = run_elem['textRun'].get('content', '')
                    start = run_elem.get('startIndex', 0)
                    text += content
                    segments.append({'startIndex': start, 'endIndex': start + len(content), 'text': content})
        elif 'table' in elem:
            for row in elem['table'].get('tableRows', []):
                for cell in row.get('tableCells', []):
                    sub_text, sub_segs = extract_text_segments(cell.get('content', []))
                    text += sub_text
                    segments.extend(sub_segs)
        elif 'tableOfContents' in elem:
            sub_text, sub_segs = extract_text_segments(elem['tableOfContents'].get('content', []))
            text += sub_text
            segments.extend(sub_segs)
    return text, segments


def resolve_tab(doc, tab_id=None):
    """Return (content_elements, resolved_tab_id) for the target tab of a documents.get response.

    - No tabs (legacy doc, or includeTabsContent omitted): returns (doc.body.content, '').
    - tab_id given: locates that tab (recursing childTabs); returns (None, None) if absent.
    - tab_id None with tabs present: uses the first tab.
    Pass the returned tab_id into any batchUpdate range/location that needs a tabId.
    """
    tabs = doc.get('tabs', [])
    if not tabs:
        return doc.get('body', {}).get('content', []), ''

    def _find(ts, tid):
        for t in ts:
            if not tid or t.get('tabProperties', {}).get('tabId') == tid:
                return t
            found = _find(t.get('childTabs', []), tid)
            if found:
                return found
        return None

    tab = _find(tabs, tab_id) if tab_id else tabs[0]
    if not tab:
        return None, None
    resolved = tab.get('tabProperties', {}).get('tabId', '')
    return tab.get('documentTab', {}).get('body', {}).get('content', []), resolved


# --- Brand-guide parsing (docs-create-branded) ---------------------------------
#
# The brand guide is a plain Doc of "Key: Value" lines (see workspace-docs
# SKILL.md "Brand guide format"). Real brand docs often LOSE their line breaks — a
# Markdown import collapses consecutive lines into one paragraph — so a naive
# line.split(':', 1) parse swallows a whole block into one value (the entire
# TYPOGRAPHY block became the "Heading Font" value; PRIMARY swallowed the rest of
# COLORS). parse_brand_guide is robust: it captures each known key's value only up
# to the NEXT known key, a newline, or end-of-text.

# Supported keys -> brand[] field, LONGEST label first so a multi-word label wins
# over its prefix ("heading 1 size" over "heading font"; "body text/font/size"
# over "body"). These are the fields the docs-create-branded CSS actually consumes.
_BRAND_KEY_MAP = [
    ('heading 1 size', 'h2_size'),
    ('heading 2 size', 'h2_size'),
    ('heading 3 size', 'h3_size'),
    ('heading font',   'heading_font'),
    ('body text',      'body_color'),
    ('body font',      'body_font'),
    ('body size',      'body_size'),
    ('title size',     'title_size'),
    ('callout bg',     'callout_bg'),
    ('primary',        'primary'),
    ('secondary',      'secondary'),
    ('accent',         'accent'),
    ('surface',        'surface'),
    ('muted',          'muted'),
]
# Documented labels the CSS does not (yet) consume. They carry no field, but MUST
# still terminate a preceding value so it never swallows the next "Key:" pair.
_BRAND_STOP_LABELS = [
    'table header background', 'table header text', 'table row alt', 'heading text',
    'divider color', 'link color', 'line spacing', 'margins', 'logo url', 'header', 'footer',
]
_BRAND_COLOR_FIELDS = {'primary', 'secondary', 'accent', 'body_color', 'muted', 'surface', 'callout_bg'}
_BRAND_SIZE_FIELDS = {'title_size', 'h2_size', 'h3_size', 'body_size'}


def parse_brand_guide(plain, brand):
    """Apply brand-guide overrides from `plain` text onto the `brand` dict, in place.

    Each known key's value is captured only up to the next known key, a newline, or
    end-of-text — so a brand doc that lost its line breaks (a Markdown import that
    collapsed "Key: Value" lines into one paragraph) parses correctly instead of
    swallowing a whole block into one value. Colors must be a hex literal; bare font
    sizes get a 'pt' unit. Unknown/unsupported labels are ignored but still bound
    values. Returns `brand` for convenience.
    """
    import re
    labels = sorted(
        {k for k, _ in _BRAND_KEY_MAP} | set(_BRAND_STOP_LABELS),
        key=len, reverse=True,
    )
    stop = '|'.join(re.escape(s) for s in labels)
    pair_re = re.compile(
        r'(' + stop + r')\s*:\s*(.*?)(?=\s*(?:' + stop + r')\s*:|[\r\n]|$)',
        re.IGNORECASE,
    )
    field_of = dict(_BRAND_KEY_MAP)
    for m in pair_re.finditer(plain):
        field = field_of.get(m.group(1).strip().lower())
        value = m.group(2).strip()
        if not field or not value:
            continue
        if field in _BRAND_COLOR_FIELDS:
            hexm = re.match(r'#[0-9A-Fa-f]{3,8}\b', value)
            if not hexm:
                continue
            value = hexm.group(0)
        elif field in _BRAND_SIZE_FIELDS:
            numm = re.match(r'(\d+(?:\.\d+)?)\s*(pt|px)?', value)
            if not numm:
                continue
            value = numm.group(1) + (numm.group(2) or 'pt')
        else:  # font family — value already bounded; tidy trailing punctuation
            value = value.strip().strip('.,;')
        brand[field] = value
    return brand

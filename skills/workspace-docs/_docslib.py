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

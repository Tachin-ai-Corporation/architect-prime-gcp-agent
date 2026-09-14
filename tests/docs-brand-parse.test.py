#!/usr/bin/env python3
"""tests/docs-brand-parse.test.py — parse_brand_guide (skills/workspace-docs/_docslib.py).

Regression for the docs-create-branded brand bug: a Markdown-authored brand guide
loses its line breaks, so the old `line.split(':', 1)` parse swallowed the whole
TYPOGRAPHY block into the "Heading Font" value and PRIMARY swallowed the rest of
COLORS (teal never applied; defaults used). parse_brand_guide must extract each key
correctly whether the doc keeps its line breaks or not.

Python test (the parser is python); run standalone:  python tests/docs-brand-parse.test.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'skills', 'workspace-docs'))
from _docslib import parse_brand_guide  # noqa: E402

DEFAULTS = {
    'primary': '#1B2A4A', 'secondary': '#3D5A80', 'accent': '#E07A5F',
    'body_color': '#2D3748', 'muted': '#718096', 'surface': '#F7F8FA',
    'callout_bg': '#F0F4F8', 'white': '#FFFFFF', 'border': '#E2E8F0',
    'heading_font': 'Montserrat', 'body_font': 'Open Sans',
    'title_size': '22pt', 'h2_size': '16pt', 'h3_size': '13pt',
    'body_size': '11pt', 'table_header_size': '10pt', 'table_cell_size': '10pt',
    'caption_size': '9pt',
}

SEPARATED = """Brand Guide: Tachin Executive Brief
COLORS
Primary: #0E7490
Secondary: #0B5563
Accent: #0E7490
Heading Text: #0F172A
Body Text: #1F2933
Table Header Background: #E6F1F4
Table Header Text: #0B5563
Table Row Alt: #F5F8FA
TYPOGRAPHY
Heading Font: Montserrat
Body Font: Open Sans
Title Size: 26
Heading 1 Size: 20
Heading 2 Size: 15
Heading 3 Size: 12
Body Size: 11
Line Spacing: 115
"""

# The SAME guide after a Markdown import collapsed each block onto one line (the bug).
COLLAPSED = (
    "Brand Guide: Tachin Executive Brief "
    "COLORS Primary: #0E7490 Secondary: #0B5563 Accent: #0E7490 Heading Text: #0F172A "
    "Body Text: #1F2933 Table Header Background: #E6F1F4 Table Header Text: #0B5563 Table Row Alt: #F5F8FA "
    "TYPOGRAPHY Heading Font: Montserrat Body Font: Open Sans Title Size: 26 "
    "Heading 1 Size: 20 Heading 2 Size: 15 Heading 3 Size: 12 Body Size: 11 Line Spacing: 115"
)

# field -> expected value after parsing either input.
EXPECT = {
    'primary': '#0E7490',        # teal applied — NOT swallowed, NOT the default navy
    'secondary': '#0B5563',
    'accent': '#0E7490',
    'body_color': '#1F2933',
    'heading_font': 'Montserrat',  # NOT "Montserrat Body Font: Open Sans Title Size..."
    'body_font': 'Open Sans',
    'title_size': '26pt',          # a bare number gains a 'pt' unit
    'h2_size': '15pt',             # heading 2 size wins h2_size (preserved original mapping)
    'h3_size': '12pt',
    'body_size': '11pt',
}

ok = True


def check(name, plain):
    global ok
    b = dict(DEFAULTS)
    parse_brand_guide(plain, b)
    fails = [f"{k}={b[k]!r} (want {v!r})" for k, v in EXPECT.items() if b[k] != v]
    if fails:
        print(f"FAIL [{name}]:")
        for f in fails:
            print("   ", f)
        ok = False
    else:
        print(f"ok   [{name}]")


check('separated (documented format)', SEPARATED)
check('collapsed (markdown lost line breaks)', COLLAPSED)

# An unsupported label must not clobber a supported one.
b = dict(DEFAULTS)
parse_brand_guide("Primary: #0E7490 Table Header Background: #E6F1F4", b)
if b['primary'] != '#0E7490':
    print(f"FAIL [no-clobber]: primary={b['primary']!r} (want '#0E7490')")
    ok = False
else:
    print("ok   [no-clobber: 'table header background' does not overwrite primary]")

# Defaults survive a guide with no recognizable keys.
b = dict(DEFAULTS)
parse_brand_guide("Nothing useful here.", b)
if b['primary'] != '#1B2A4A' or b['heading_font'] != 'Montserrat':
    print("FAIL [defaults]: overrode on an empty guide")
    ok = False
else:
    print("ok   [defaults preserved when no keys present]")

print("PASS" if ok else "SOME TESTS FAILED")
sys.exit(0 if ok else 1)

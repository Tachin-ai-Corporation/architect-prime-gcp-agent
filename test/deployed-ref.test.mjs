// test/deployed-ref.test.mjs — showing what is running, not what main says
//
// The dashboard's catalog views fetch from GitHub `main`, which answers "what
// would a fresh install get today". That is a different question from "what is
// this deployment running", and the two look identical right up until they
// diverge — which is the moment you most need them not to. /api/contracts even
// required a primeId and then ignored it.
//
// A prime's `coreRef` is initialised to the literal string "main" and only
// becomes a commit once a deploy resolves one, so the field holds two genuinely
// different kinds of thing. Collapsing them is how a moving target gets
// displayed as a version.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDeployedRef, contentUrlAt } from '../app/src/lib/deployed-ref.ts';

const SHA = 'a5e8138769563ca2c458dbca3665cea856b7daec';

test('a real commit is pinned and needs no caveat', () => {
  const r = resolveDeployedRef(SHA);
  assert.equal(r.kind, 'pinned');
  assert.equal(r.ref, SHA);
  assert.equal(r.caveat, null);
});

test('the literal "main" is a moving target, not a version', () => {
  const r = resolveDeployedRef('main');
  assert.equal(r.kind, 'floating');
  assert.match(r.caveat, /not necessarily what is running/);
});

test('a missing ref falls back to main and says why', () => {
  for (const missing of [null, undefined, '']) {
    const r = resolveDeployedRef(missing);
    assert.equal(r.ref, 'main');
    assert.equal(r.kind, 'floating');
    assert.ok(r.caveat && r.caveat.length > 20, 'the fallback must be visible, not silent');
  }
});

test('another branch is honoured but still flagged as moving', () => {
  const r = resolveDeployedRef('release/2026-08');
  assert.equal(r.ref, 'release/2026-08');
  assert.equal(r.kind, 'floating');
  assert.match(r.caveat, /moves/);
});

test('a short or malformed sha is not mistaken for a pinned commit', () => {
  // A 12-char prefix is what gets shown in logs; treating it as pinned would
  // build a URL that 404s and report it as the deployed version.
  for (const bad of ['a5e8138', 'a5e8138769563ca2c458dbca3665cea856b7dae', 'A5E8138769563CA2C458DBCA3665CEA856B7DAEC', 'not-a-sha']) {
    assert.notEqual(resolveDeployedRef(bad).kind, 'pinned', `${bad} must not read as a pinned commit`);
  }
});

test('the content URL is built at the resolved ref, never at main by default', () => {
  const base = 'https://raw.githubusercontent.com/OWNER/REPO';
  assert.equal(
    contentUrlAt(base, resolveDeployedRef(SHA), 'infra/contracts.json'),
    `${base}/${SHA}/infra/contracts.json`,
  );
  assert.equal(
    contentUrlAt(base, resolveDeployedRef(SHA), '/infra/contracts.json'),
    `${base}/${SHA}/infra/contracts.json`,
    'a leading slash must not produce a doubled separator',
  );
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const contractsPath = join(__dirname, '..', 'infra', 'contracts.json');

describe('contracts.json', () => {
  let contracts;

  // Parse once — tests below reference the parsed object
  it('is valid JSON', () => {
    const raw = readFileSync(contractsPath, 'utf8');
    contracts = JSON.parse(raw);
    assert.ok(contracts, 'parsed contracts should be truthy');
  });

  describe('top-level structure', () => {
    it('has all required top-level keys', () => {
      const required = ['vertex', 'agents', 'gateway', 'dispatch', 'utility', 'versioning'];
      for (const key of required) {
        assert.ok(
          Object.hasOwn(contracts, key),
          `missing required top-level key: "${key}"`
        );
      }
    });
  });

  describe('vertex section', () => {
    it('vertex.models has cortex, cortexFallback, and subagent', () => {
      const models = contracts.vertex?.models;
      assert.ok(models, 'vertex.models should exist');
      assert.equal(typeof models.cortex, 'string', 'cortex should be a string');
      assert.equal(typeof models.cortexFallback, 'string', 'cortexFallback should be a string');
      assert.equal(typeof models.subagent, 'string', 'subagent should be a string');
    });
  });

  describe('agents section', () => {
    it('has defaultId (string) and subagentIds (array)', () => {
      const agents = contracts.agents;
      assert.ok(agents, 'agents section should exist');
      assert.equal(typeof agents.defaultId, 'string', 'defaultId should be a string');
      assert.ok(Array.isArray(agents.subagentIds), 'subagentIds should be an array');
      assert.ok(agents.subagentIds.length > 0, 'subagentIds should not be empty');
    });
  });

  describe('gateway section', () => {
    it('has port (number), timeoutSeconds (number), bind (string)', () => {
      const gw = contracts.gateway;
      assert.ok(gw, 'gateway section should exist');
      assert.equal(typeof gw.port, 'number', 'port should be a number');
      assert.equal(typeof gw.timeoutSeconds, 'number', 'timeoutSeconds should be a number');
      assert.equal(typeof gw.bind, 'string', 'bind should be a string');
    });
  });

  describe('dispatch section', () => {
    it('has max_iterations > 0', () => {
      const d = contracts.dispatch;
      assert.ok(d, 'dispatch section should exist');
      assert.equal(typeof d.max_iterations, 'number', 'max_iterations should be a number');
      assert.ok(d.max_iterations > 0, 'max_iterations should be greater than 0');
    });
  });

  describe('utility section', () => {
    it('has model (string)', () => {
      const u = contracts.utility;
      assert.ok(u, 'utility section should exist');
      assert.equal(typeof u.model, 'string', 'model should be a string');
    });
  });

  describe('versioning — canonicalRegex', () => {
    let re;

    it('is a valid regex', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(re instanceof RegExp);
    });

    it('matches v2026.06.11.1.0', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(re.test('v2026.06.11.1.0'), 'should match canonical version');
    });

    it('matches v2025.01.01.0.0', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(re.test('v2025.01.01.0.0'), 'should match canonical version');
    });

    it('does NOT match v1.0', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(!re.test('v1.0'), 'should not match short version');
    });

    it('does NOT match "foo"', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(!re.test('foo'), 'should not match arbitrary string');
    });

    it('does NOT match empty string', () => {
      re = new RegExp(contracts.versioning.canonicalRegex);
      assert.ok(!re.test(''), 'should not match empty string');
    });
  });

  describe('versioning — backcompatRegex', () => {
    let re;

    it('is a valid regex', () => {
      re = new RegExp(contracts.versioning.backcompatRegex);
      assert.ok(re instanceof RegExp);
    });

    it('matches v5.3.0', () => {
      re = new RegExp(contracts.versioning.backcompatRegex);
      assert.ok(re.test('v5.3.0'), 'should match backcompat version');
    });

    it('matches v1.0.0', () => {
      re = new RegExp(contracts.versioning.backcompatRegex);
      assert.ok(re.test('v1.0.0'), 'should match backcompat version');
    });

    it('does NOT match "foo"', () => {
      re = new RegExp(contracts.versioning.backcompatRegex);
      assert.ok(!re.test('foo'), 'should not match arbitrary string');
    });
  });
});

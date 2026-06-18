# Skill: Test Runner Operations

## When to Use
When running test suites, collecting code coverage metrics, analyzing test logs, or detecting flaky tests across Node.js, Python, or Go environments.

## Commands

No custom corekit scripts are governed directly by this skill.

## Procedures

### Run test suite and check coverage
1. Identify the project type (Node.js, Python, or Go).
2. Run the appropriate test command with coverage collection flags:
   - Node: `npx jest --coverage --coverageReporters=text 2>&1`
   - Python: `python -m pytest --cov=. --cov-report=term-missing 2>&1`
   - Go: `go test -coverprofile=coverage.out ./... 2>&1`
3. Verify: Check that the test runner outputs a coverage summary containing percentages for statements, branches, functions, and lines.

### Troubleshoot a failing test
1. Retrieve the names or files of failing tests from the build output.
2. Run only the failed test(s) with verbose output redirected:
   - Jest: `npx jest path/to/failed.test.ts --verbose 2>&1`
   - Pytest: `python -m pytest path/to/failed.py -v --tb=short 2>&1`
3. Verify: Inspect the stack trace and error message details to identify the cause of the failure.

### Detect flaky tests
1. Run the test suite multiple times in a loop or using runner repeat features:
   - Go: `go test ./... -count=5 -v 2>&1`
   - Pytest: `python -m pytest --count=5 -x 2>&1`
   - Node: Run in a loop: `for i in {1..5}; do npm test 2>&1; done`
2. Verify: Compare the outcomes of each run. If a test passes in some runs and fails in others, flag it as a flaky test.

---

## Environment Reference

### Node.js / JavaScript / TypeScript
```bash
# Run all tests
npm test 2>&1

# Run specific test file
npx jest PATH/TO/TEST.test.ts 2>&1

# Jest built-in coverage
npx jest --coverage --coverageReporters=text 2>&1
```

### Python
```bash
# Run all tests
python -m pytest -v 2>&1

# Run specific test file
python -m pytest tests/test_module.py -v 2>&1

# Collect coverage
python -m pytest --cov=. --cov-report=term-missing 2>&1
```

### Go
```bash
# Run all tests
go test ./... -v 2>&1

# Basic coverage
go test -cover ./... 2>&1
```

## Safety Rules
- Always redirect stderr with `2>&1` to capture full output
- Use timeouts to prevent hanging tests from blocking execution
- Never modify test files during a test run — read-only analysis
- Save results to files for comparison, not just stdout
- Report exact test names and file paths for failures

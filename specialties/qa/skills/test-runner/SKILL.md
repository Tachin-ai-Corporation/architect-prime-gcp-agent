# Skill: Test Runner Operations

## What this skill does
Test execution procedures — npm test, pytest, go test, coverage collection, regression diffing, flaky detection

## When to use
When running test suites, collecting coverage, or analyzing test results

Use these procedures when running tests and collecting results via `exec`.

## Test Execution

### Node.js / JavaScript / TypeScript
```bash
# Run all tests
npm test 2>&1

# Run specific test file
npx jest PATH/TO/TEST.test.ts 2>&1

# Run tests matching pattern
npx jest --testNamePattern="pattern" 2>&1

# Run with verbose output
npx jest --verbose 2>&1

# Run only changed tests
npx jest --changedSince=origin/main 2>&1
```

### Python
```bash
# Run all tests
python -m pytest -v 2>&1

# Run specific test file
python -m pytest tests/test_module.py -v 2>&1

# Run tests matching pattern
python -m pytest -k "pattern" -v 2>&1

# Run with short traceback
python -m pytest --tb=short 2>&1

# Run last failed
python -m pytest --lf -v 2>&1
```

### Go
```bash
# Run all tests
go test ./... -v 2>&1

# Run specific package
go test ./pkg/NAME -v 2>&1

# Run tests matching pattern
go test ./... -run "TestPattern" -v 2>&1

# Run with race detection
go test ./... -race 2>&1

# Run with timeout
go test ./... -timeout 120s 2>&1
```

## Coverage Collection

### Node.js (nyc / jest)
```bash
# Jest built-in coverage
npx jest --coverage --coverageReporters=text 2>&1

# With nyc
npx nyc npm test 2>&1

# Coverage summary only
npx jest --coverage --coverageReporters=text-summary 2>&1

# JSON output for parsing
npx jest --coverage --coverageReporters=json --coverageDirectory=./coverage 2>&1
```

### Python (coverage.py)
```bash
# Collect coverage
python -m pytest --cov=. --cov-report=term-missing 2>&1

# Coverage with threshold check
python -m pytest --cov=. --cov-fail-under=80 2>&1

# HTML report
python -m pytest --cov=. --cov-report=html 2>&1

# JSON report for parsing
python -m pytest --cov=. --cov-report=json 2>&1
```

### Go
```bash
# Basic coverage
go test -cover ./... 2>&1

# Coverage profile
go test -coverprofile=coverage.out ./... 2>&1

# Coverage by function
go tool cover -func=coverage.out

# Coverage percentage only
go test -cover ./... 2>&1 | grep -oP 'coverage: \K[0-9.]+%'
```

## Structured Result Output

Collect test results in a standard format for reporting:

```bash
# Jest JSON output
npx jest --json --outputFile=test-results.json 2>&1

# Pytest JUnit XML
python -m pytest --junitxml=test-results.xml 2>&1

# Go JSON output
go test ./... -json 2>&1 > test-results.json

# Parse summary from Jest JSON
cat test-results.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"Tests: {d['numPassedTests']} passed, {d['numFailedTests']} failed, {d['numTotalTests']} total\")
print(f\"Suites: {d['numPassedTestSuites']} passed, {d['numFailedTestSuites']} failed\")
print(f\"Time: {d['testResults'][0]['perfStats']['runtime'] if d['testResults'] else 0}ms\")
"
```

## Screenshot and Log Collection

```bash
# Capture test output to file
npm test 2>&1 | tee test-output.log

# Capture stderr separately
npm test > test-stdout.log 2> test-stderr.log

# Tail last N lines of failure output
npm test 2>&1 | tail -50

# Extract failed test names from Jest output
npx jest 2>&1 | grep "FAIL\|●" | head -20

# Extract failed test names from pytest
python -m pytest 2>&1 | grep "FAILED\|ERROR" | head -20
```

## Regression Diff: Current vs Baseline

```bash
# Save baseline results
npm test 2>&1 > baseline-results.txt

# Run current tests
npm test 2>&1 > current-results.txt

# Diff results
diff baseline-results.txt current-results.txt || echo "REGRESSION DETECTED"

# Compare coverage numbers
# 1. Save baseline coverage
npx jest --coverage --coverageReporters=json --coverageDirectory=./baseline-coverage 2>&1
# 2. Run current coverage
npx jest --coverage --coverageReporters=json --coverageDirectory=./current-coverage 2>&1
# 3. Compare
python3 -c "
import json
with open('baseline-coverage/coverage-summary.json') as f: base = json.load(f)
with open('current-coverage/coverage-summary.json') as f: curr = json.load(f)
for metric in ['lines', 'statements', 'functions', 'branches']:
    b = base['total'][metric]['pct']
    c = curr['total'][metric]['pct']
    delta = c - b
    flag = '⬇️' if delta < 0 else '✅'
    print(f'{flag} {metric}: {b}% → {c}% ({delta:+.1f}%)')
"
```

## Flaky Test Detection

```bash
# Run tests N times, collect results
for i in $(seq 1 5); do
  echo "=== Run $i ==="
  npm test 2>&1 | grep -E "PASS|FAIL" | sort
done | tee flaky-check.log

# Count pass/fail per test across runs
grep -E "PASS|FAIL" flaky-check.log | sort | uniq -c | sort -rn

# Pytest repeat plugin
python -m pytest --count=5 -x 2>&1

# Go test with count
go test ./... -count=5 -v 2>&1
```

## Safety Rules
- Always redirect stderr with `2>&1` to capture full output
- Use timeouts to prevent hanging tests from blocking execution
- Never modify test files during a test run — read-only analysis
- Save results to files for comparison, not just stdout
- Report exact test names and file paths for failures
- Use `--format=json` or structured output when chaining commands

import { expect, test } from 'claude-code/testing'

import {
  merge,
  parseDotnetList,
  parseDotnetRun,
  parsePluginTestRun,
  parsePluginTestSource,
  parsePytestList,
  parsePytestRun,
  parseVitestList,
  parseVitestRun,
} from '../hooks/adapters'

test('dotnet: lists tests and reads results with their error messages', () => {
  const listed = parseDotnetList(
    'Build succeeded.\nThe following Tests are available:\n    App.Tests.MathTests.Adds\n    App.Tests.MathTests.Divides(x: 1.5)\n',
  )
  expect(listed.map(t => [t.group, t.name])).toEqual([
    ['App.Tests.MathTests', 'App.Tests.MathTests.Adds'],
    ['App.Tests.MathTests', 'App.Tests.MathTests.Divides(x: 1.5)'],
  ])

  const outcomes = parseDotnetRun(
    [
      '  Passed App.Tests.MathTests.Adds [3 ms]',
      '  Failed App.Tests.MathTests.Divides(x: 1.5) [1 s]',
      '  Error Message:',
      '   Assert.Equal() Failure',
      '  Stack Trace:',
      '     at App.Tests.MathTests.Divides() in MathTests.cs:line 12',
      '',
    ].join('\r\n'),
  )
  expect(outcomes[0]).toEqual({ name: 'App.Tests.MathTests.Adds', status: 'passed', ms: 3 })
  expect(outcomes[1]?.ms).toBe(1000)
  expect(outcomes[1]?.message).toContain('Assert.Equal() Failure')
  expect(outcomes[1]?.message).toContain('MathTests.cs:line 12')
})

test('pytest: collects node ids and reads the summary and failure blocks', () => {
  const listed = parsePytestList('tests/test_math.py::test_add\ntests/test_math.py::TestDiv::test_zero\n\n2 tests collected in 0.01s\n')
  expect(listed.map(t => t.group)).toEqual(['tests/test_math.py', 'tests/test_math.py::TestDiv'])

  const outcomes = parsePytestRun(
    [
      '.F',
      '=================================== FAILURES ===================================',
      '_____________________________ TestDiv.test_zero ______________________________',
      '    def test_zero(self):',
      '>       assert 1 / 0',
      'E       ZeroDivisionError: division by zero',
      '=========================== short test summary info ============================',
      'PASSED tests/test_math.py::test_add',
      'FAILED tests/test_math.py::TestDiv::test_zero - ZeroDivisionError: division by zero',
      '1 failed, 1 passed in 0.02s',
    ].join('\n'),
  )
  expect(outcomes.map(o => o.status)).toEqual(['passed', 'failed'])
  expect(outcomes[1]?.message).toContain('ZeroDivisionError')
})

test('vitest: lists by file relative to the project and reads the JSON report', () => {
  const listed = parseVitestList('[{"name":"math > adds","file":"C:/repo/web/src/math.test.ts"}]', 'C:/repo/web')
  expect(listed).toEqual([{ name: 'math > adds', group: 'src/math.test.ts', status: 'unknown' }])

  const outcomes = parseVitestRun(
    JSON.stringify({
      testResults: [
        {
          name: 'C:\\repo\\web\\src\\math.test.ts',
          assertionResults: [
            { title: 'adds', ancestorTitles: ['math'], status: 'failed', duration: 4, failureMessages: ['expected 3 to be 4'] },
          ],
        },
      ],
    }),
    'C:/repo/web',
  )
  expect(outcomes).toEqual([
    { name: 'math > adds', group: 'src/math.test.ts', status: 'failed', ms: 4, message: 'expected 3 to be 4' },
  ])
})

test('claude plugin test: finds tests in source and reads pass and fail lines', () => {
  const listed = parsePluginTestSource("test('opens the pane', async () => {})\ntest(\"counts\", () => {})", 'pane.test.tsx')
  expect(listed.map(t => t.name)).toEqual(['opens the pane', 'counts'])

  const outcomes = parsePluginTestRun(
    [
      'tests\\pane.test.tsx:',
      '(pass) opens the pane [12.5ms]',
      '(fail) counts [3.1ms]',
      '  AssertionError: expected 2 to be 3',
      '',
      ' 1 pass',
    ].join('\n'),
  )
  expect(outcomes).toEqual([
    { name: 'opens the pane', group: 'pane.test.tsx', status: 'passed', ms: 12.5 },
    { name: 'counts', group: 'pane.test.tsx', status: 'failed', ms: 3.1, message: 'AssertionError: expected 2 to be 3' },
  ])
})

test('merge matches short result names to listed full names and keeps unlisted results', () => {
  const merged = merge(
    [{ name: 'App.Tests.MathTests.Adds', group: 'App.Tests.MathTests', status: 'passed' }],
    [
      { name: 'Adds', status: 'failed', message: 'boom' },
      { name: 'New', group: 'g', status: 'passed' },
    ],
  )
  expect(merged).toEqual([
    { name: 'App.Tests.MathTests.Adds', group: 'App.Tests.MathTests', status: 'failed', ms: undefined, message: 'boom' },
    { name: 'New', group: 'g', status: 'passed', ms: undefined, message: undefined },
  ])
})

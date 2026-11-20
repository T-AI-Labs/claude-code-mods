import { expect, test } from 'claude-code/testing'

import {
  parseCargoList,
  parseCargoRun,
  parseGoList,
  parseGoRun,
  parseJunitXml,
  parseMochaList,
  parseMochaRun,
  parsePlaywrightList,
  parsePlaywrightRun,
  parseRspecRun,
  parseVitestRun,
} from '../hooks/adapters'

test('jest: reads the JSON report it shares with Vitest', () => {
  const report = JSON.stringify({
    testResults: [
      {
        name: '/repo/web/src/sum.test.js',
        assertionResults: [
          { ancestorTitles: ['sum'], title: 'adds', status: 'passed', duration: 4, failureMessages: [] },
          { ancestorTitles: ['sum'], title: 'skips', status: 'pending', duration: null, failureMessages: [] },
          { ancestorTitles: [], title: 'fails', status: 'failed', duration: 2, failureMessages: ['Error: expected 3'] },
        ],
      },
    ],
  })
  const outcomes = parseVitestRun(`some log\n${report}`, '/repo/web')

  expect(outcomes.map(o => [o.group, o.name, o.status])).toEqual([
    ['src/sum.test.js', 'sum > adds', 'passed'],
    ['src/sum.test.js', 'sum > skips', 'skipped'],
    ['src/sum.test.js', 'fails', 'failed'],
  ])
  expect(outcomes[2]?.message).toBe('Error: expected 3')
})

test('mocha: lists from a dry run and reads passes, failures and pending tests', () => {
  const fail = {
    title: 'divides',
    fullTitle: 'math divides',
    file: '/repo/api/test/math.spec.js',
    duration: 2,
    err: { message: 'expected 1 to equal 2', stack: 'AssertionError: expected 1 to equal 2\n    at Context.<anonymous>' },
  }
  const report = JSON.stringify({
    tests: [
      { title: 'adds', fullTitle: 'math adds', file: '/repo/api/test/math.spec.js', duration: 1, err: {} },
      fail,
      { title: 'later', fullTitle: 'math later', file: '/repo/api/test/math.spec.js', err: {} },
    ],
    failures: [fail],
    pending: [{ title: 'later', fullTitle: 'math later', file: '/repo/api/test/math.spec.js' }],
  })

  expect(parseMochaList(report, '/repo/api').map(t => [t.group, t.name, t.status])).toEqual([
    ['test/math.spec.js', 'math adds', 'unknown'],
    ['test/math.spec.js', 'math divides', 'unknown'],
    ['test/math.spec.js', 'math later', 'unknown'],
  ])

  const outcomes = parseMochaRun(report, '/repo/api')

  expect(outcomes.map(o => o.status)).toEqual(['passed', 'failed', 'skipped'])
  expect(outcomes[1]?.message).toContain('expected 1 to equal 2')
})

test('playwright: names a test by its describe blocks and project, and reads its last result', () => {
  const report = JSON.stringify({
    suites: [
      {
        title: 'login.spec.ts',
        file: 'login.spec.ts',
        specs: [],
        suites: [
          {
            title: 'login',
            file: 'login.spec.ts',
            specs: [
              {
                title: 'signs in',
                file: 'login.spec.ts',
                tests: [{ projectName: 'chromium', status: 'expected', results: [{ status: 'passed', duration: 812 }] }],
              },
              {
                title: 'rejects a wrong password',
                file: 'login.spec.ts',
                tests: [
                  {
                    projectName: 'chromium',
                    status: 'unexpected',
                    results: [{ status: 'failed', duration: 300, error: { message: '\u001b[31mError: expect(received).toBe(expected)\u001b[39m' } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })

  expect(parsePlaywrightList(report, '/repo/e2e').map(t => t.name)).toEqual([
    'login > signs in [chromium]',
    'login > rejects a wrong password [chromium]',
  ])

  const outcomes = parsePlaywrightRun(report, '/repo/e2e')

  expect(outcomes.map(o => [o.group, o.status, o.ms])).toEqual([
    ['login.spec.ts', 'passed', 812],
    ['login.spec.ts', 'failed', 300],
  ])
  expect(outcomes[1]?.message).toBe('Error: expect(received).toBe(expected)')
})

test('go: lists tests by package and reads the JSON events with the failing output', () => {
  const listed = parseGoList(
    ['TestAdd', 'TestDivide', 'ok  \texample.com/calc\t0.002s', '?   \texample.com/calc/cmd\t[no test files]', 'TestParse', 'ok  \texample.com/calc/parse\t0.001s'].join('\n'),
  )

  expect(listed.map(t => [t.group, t.name])).toEqual([
    ['example.com/calc', 'TestAdd'],
    ['example.com/calc', 'TestDivide'],
    ['example.com/calc/parse', 'TestParse'],
  ])

  const events = [
    { Action: 'run', Package: 'example.com/calc', Test: 'TestAdd' },
    { Action: 'pass', Package: 'example.com/calc', Test: 'TestAdd', Elapsed: 0.01 },
    { Action: 'run', Package: 'example.com/calc', Test: 'TestDivide' },
    { Action: 'output', Package: 'example.com/calc', Test: 'TestDivide', Output: '    calc_test.go:14: got 1, want 2\n' },
    { Action: 'fail', Package: 'example.com/calc', Test: 'TestDivide', Elapsed: 0 },
    { Action: 'fail', Package: 'example.com/calc', Elapsed: 0.02 },
  ]
  const outcomes = parseGoRun(events.map(e => JSON.stringify(e)).join('\n'))

  expect(outcomes.map(o => [o.name, o.status, o.ms])).toEqual([
    ['TestAdd', 'passed', 10],
    ['TestDivide', 'failed', 0],
  ])
  expect(outcomes[1]?.message).toContain('got 1, want 2')
})

test('cargo: lists tests by module and reads the result lines and the failure blocks', () => {
  expect(parseCargoList('tests::adds: test\ntests::divides: test\nbench_sum: benchmark\n').map(t => [t.group, t.name])).toEqual([
    ['tests', 'tests::adds'],
    ['tests', 'tests::divides'],
  ])

  const outcomes = parseCargoRun(
    [
      'running 3 tests',
      'test tests::adds ... ok',
      'test tests::divides ... FAILED',
      'test tests::slow ... ignored',
      '',
      'failures:',
      '',
      '---- tests::divides stdout ----',
      "thread 'tests::divides' panicked at src/lib.rs:12:9:",
      'assertion `left == right` failed',
      '',
      'failures:',
      '    tests::divides',
      '',
      'test result: FAILED. 1 passed; 1 failed; 1 ignored',
    ].join('\n'),
  )

  expect(outcomes.map(o => [o.name, o.status])).toEqual([
    ['tests::adds', 'passed'],
    ['tests::divides', 'failed'],
    ['tests::slow', 'skipped'],
  ])
  expect(outcomes[1]?.message).toContain('panicked at src/lib.rs:12:9')
})

test('junit: reads Maven and Gradle reports with failures, errors and skipped tests', () => {
  const outcomes = parseJunitXml(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuite name="com.acme.CalcTest" tests="4">',
      '  <testcase name="adds" classname="com.acme.CalcTest" time="0.012"/>',
      '  <testcase name="divides" classname="com.acme.CalcTest" time="0.003">',
      '    <failure message="expected: &lt;2&gt; but was: &lt;1&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[at com.acme.CalcTest.divides(CalcTest.java:20)]]></failure>',
      '  </testcase>',
      '  <testcase name="parses" classname="com.acme.CalcTest" time="0"><error message="boom" type="java.lang.IllegalStateException"/></testcase>',
      '  <testcase name="later" classname="com.acme.CalcTest" time="0"><skipped/></testcase>',
      '</testsuite>',
    ].join('\n'),
  )

  expect(outcomes.map(o => [o.group, o.name, o.status, o.ms])).toEqual([
    ['com.acme.CalcTest', 'adds', 'passed', 12],
    ['com.acme.CalcTest', 'divides', 'failed', 3],
    ['com.acme.CalcTest', 'parses', 'failed', 0],
    ['com.acme.CalcTest', 'later', 'skipped', 0],
  ])
  expect(outcomes[1]?.message).toBe('expected: <2> but was: <1>\nat com.acme.CalcTest.divides(CalcTest.java:20)')
  expect(outcomes[2]?.message).toBe('boom')
})

test('rspec: reads the JSON formatter', () => {
  const outcomes = parseRspecRun(
    `Randomized with seed 1234\n${JSON.stringify({
      examples: [
        { full_description: 'Calc adds', file_path: './spec/calc_spec.rb', status: 'passed', run_time: 0.002 },
        {
          full_description: 'Calc divides',
          file_path: './spec/calc_spec.rb',
          status: 'failed',
          run_time: 0.001,
          exception: { class: 'RSpec::Expectations::ExpectationNotMetError', message: 'expected 2, got 1' },
        },
        { full_description: 'Calc later', file_path: './spec/calc_spec.rb', status: 'pending' },
      ],
    })}`,
  )

  expect(outcomes.map(o => [o.group, o.name, o.status])).toEqual([
    ['spec/calc_spec.rb', 'Calc adds', 'passed'],
    ['spec/calc_spec.rb', 'Calc divides', 'failed'],
    ['spec/calc_spec.rb', 'Calc later', 'skipped'],
  ])
  expect(outcomes[1]?.message).toBe('RSpec::Expectations::ExpectationNotMetError: expected 2, got 1')
})

import { expect, test } from './fixtures.js'

test('local wall-clock freezing preserves real animation frames', async ({
  page,
  fixtureRuntime
}) => {
  test.skip(fixtureRuntime.server === undefined, 'The local fixture owns the fixed clock.')
  await page.goto('/viewer', { waitUntil: 'networkidle' })
  const reference = await page.evaluate(async () => {
    const response = await fetch('/api/memory/tree/automation')
    return ((await response.json()) as { changed_at: string }).changed_at
  })
  const dates = await page.evaluate(() => {
    class DerivedDate extends Date {}
    const constructed = new Date()
    const fromConstructor = Reflect.construct(constructed.constructor, []) as Date
    const constructorDescriptor = Object.getOwnPropertyDescriptor(Date.prototype, 'constructor')
    return {
      now: Date.now(),
      constructed: constructed.getTime(),
      constructorIdentity: constructed.constructor === Date,
      constructorTime: fromConstructor.getTime(),
      constructorDescriptor: {
        configurable: constructorDescriptor?.configurable,
        enumerable: constructorDescriptor?.enumerable,
        writable: constructorDescriptor?.writable
      },
      called: Date(),
      formatted: new Date().toString(),
      parsed: Date.parse('2020-01-02T03:04:05Z'),
      utc: Date.UTC(2020, 0, 2, 3, 4, 5),
      explicitYear: new Date(2020, 0, 2, 3, 4, 5).getFullYear(),
      derived: new DerivedDate().getTime(),
      instance: new DerivedDate() instanceof Date,
      derivedConstructorIdentity: new DerivedDate().constructor === DerivedDate,
      derivedInstance: new DerivedDate() instanceof DerivedDate
    }
  })
  expect(dates.now).toBe(Date.parse(reference))
  expect(dates.constructed).toBe(dates.now)
  expect(dates.constructorIdentity).toBe(true)
  expect(dates.constructorTime).toBe(dates.now)
  expect(dates.constructorDescriptor).toEqual({
    configurable: true,
    enumerable: false,
    writable: true
  })
  expect(dates.derived).toBe(dates.now)
  expect(dates.instance).toBe(true)
  expect(dates.derivedConstructorIdentity).toBe(true)
  expect(dates.derivedInstance).toBe(true)
  expect(dates.called).toBe(dates.formatted)
  expect(dates.parsed).toBe(dates.utc)
  expect(dates.explicitYear).toBe(2020)

  // Native RAF timestamps share the document's animation timeline. A virtual
  // scheduler can invoke callbacks without a corresponding painted frame.
  const frames = await page.evaluate(async () => {
    const result: { callback: number; timeline: number }[] = []
    for (let sample = 0; sample < 3; sample += 1) {
      result.push(
        await new Promise((resolve) => {
          requestAnimationFrame((callback) =>
            resolve({ callback, timeline: Number(document.timeline.currentTime) })
          )
        })
      )
    }
    return result
  })
  for (const frame of frames) {
    expect(frame.callback).toBe(frame.timeline)
  }
  expect(await page.evaluate(() => Date.now())).toBe(dates.now)
})

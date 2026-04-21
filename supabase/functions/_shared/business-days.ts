// Business-day + NACHA holiday helpers.
//
// NACHA (the ACH network) observes Federal Reserve holidays. ACH debits submitted
// on a holiday don't process that day. If your contract says "due on X" and X is a
// holiday, the debit lands on the next business day AFTER X.
//
// These helpers let scheduling functions decide:
//   - "Is today the right day to submit this debit?"
//   - "If the due date is a weekend/holiday, what's the true fire date and will the debit land late?"
//
// All functions operate on 'YYYY-MM-DD' strings in Central Time (the reference
// timezone for Case's business). Conversion from `Date` assumes America/Chicago.

/**
 * US Federal Reserve bank holidays. NACHA observes these — ACH doesn't settle.
 *
 * Rules used (match https://www.federalreserve.gov/aboutthefed/k8.htm):
 *  - Fixed-date holidays (Jan 1, Jun 19, Jul 4, Nov 11, Dec 25):
 *      If on Sat → Fed banks observe the preceding Friday (for ACH purposes,
 *      we treat BOTH the calendar date AND the observed Friday as non-business).
 *      If on Sun → Fed banks observe the following Monday.
 *  - Floating holidays: their actual date (always Monday or Thursday).
 */
export function getFederalHolidays(year: number): Set<string> {
  const holidays = new Set<string>()
  const add = (d: Date) => holidays.add(fmtDateISO(d))

  // Fixed-date holidays with weekend-observed-date handling
  const fixedDates: Array<[number, number, string]> = [
    [0, 1, 'New Year'],
    [5, 19, 'Juneteenth'],
    [6, 4, 'Independence Day'],
    [10, 11, 'Veterans Day'],
    [11, 25, 'Christmas'],
  ]
  for (const [month, day] of fixedDates) {
    const actual = new Date(Date.UTC(year, month, day))
    const dow = actual.getUTCDay()
    if (dow === 6) {
      // Saturday → observed Friday (both non-business days for ACH)
      add(actual)
      add(new Date(Date.UTC(year, month, day - 1)))
    } else if (dow === 0) {
      // Sunday → observed Monday
      add(actual)
      add(new Date(Date.UTC(year, month, day + 1)))
    } else {
      add(actual)
    }
  }

  // Floating holidays
  add(nthWeekdayOfMonth(year, 0, 1, 3))  // MLK: 3rd Monday of January
  add(nthWeekdayOfMonth(year, 1, 1, 3))  // Presidents': 3rd Monday of February
  add(lastWeekdayOfMonth(year, 4, 1))    // Memorial: last Monday of May
  add(nthWeekdayOfMonth(year, 8, 1, 1))  // Labor: 1st Monday of September
  add(nthWeekdayOfMonth(year, 9, 1, 2))  // Columbus: 2nd Monday of October
  add(nthWeekdayOfMonth(year, 10, 4, 4)) // Thanksgiving: 4th Thursday of November

  return holidays
}

/**
 * Get the Nth occurrence (1-5) of a weekday (0=Sun..6=Sat) in a given month.
 */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}

/**
 * Last occurrence of a weekday in a given month.
 */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0))
  const offset = (lastDay.getUTCDay() - weekday + 7) % 7
  return new Date(Date.UTC(year, month, lastDay.getUTCDate() - offset))
}

/**
 * Format a Date as 'YYYY-MM-DD' (UTC basis, matching our other date-string conventions).
 */
function fmtDateISO(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Today's date in Central Time as YYYY-MM-DD.
 */
export function todayCentral(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/**
 * Is the given 'YYYY-MM-DD' date a business day (weekday and not a federal holiday)?
 */
export function isBusinessDay(dateStr: string): boolean {
  const [y, m, d] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const holidays = getFederalHolidays(y)
  return !holidays.has(dateStr)
}

/**
 * Most recent business day strictly BEFORE the given date.
 * Example: businessDayBefore('2026-05-01') → '2026-04-30' (Thu).
 *          businessDayBefore('2026-05-04') → '2026-05-01' (Fri).
 *          businessDayBefore('2026-05-26') → '2026-05-22' (Fri, because Memorial Day Mon May 25 is a holiday).
 */
export function businessDayBefore(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  let cursor = new Date(Date.UTC(y, m - 1, d))
  for (let i = 0; i < 10; i++) { // max 10 days back (no stretch of holidays > 10 days)
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000)
    const candidate = fmtDateISO(cursor)
    if (isBusinessDay(candidate)) return candidate
  }
  throw new Error(`Could not find business day before ${dateStr} in 10 attempts`)
}

/**
 * Next business day strictly AFTER the given date.
 */
export function businessDayAfter(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  let cursor = new Date(Date.UTC(y, m - 1, d))
  for (let i = 0; i < 10; i++) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
    const candidate = fmtDateISO(cursor)
    if (isBusinessDay(candidate)) return candidate
  }
  throw new Error(`Could not find business day after ${dateStr} in 10 attempts`)
}

/**
 * If `dueDate` is itself a business day, returns { fireDate: businessDayBefore(dueDate), willLandLate: false }.
 * If `dueDate` is weekend/holiday, returns { fireDate: businessDayBefore(dueDate), willLandLate: true,
 *   actualLandDate: businessDayAfter(dueDate) }.
 *
 * Callers should pass this through to logging so Case can see when a debit will land late.
 */
export function computeFireDate(dueDate: string): {
  fireDate: string
  dueIsBusinessDay: boolean
  actualLandDate: string
} {
  const fireDate = businessDayBefore(dueDate)
  const dueIsBusinessDay = isBusinessDay(dueDate)
  const actualLandDate = dueIsBusinessDay ? dueDate : businessDayAfter(dueDate)
  return { fireDate, dueIsBusinessDay, actualLandDate }
}

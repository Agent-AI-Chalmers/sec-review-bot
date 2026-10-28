import React from 'react'

/** A low-frequency clock for durations that stay on screen while the data is unchanged. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const interval = window.setInterval((): void => {
      setNow(Date.now())
    }, intervalMs)
    return (): void => {
      window.clearInterval(interval)
    }
  }, [intervalMs])
  return now
}

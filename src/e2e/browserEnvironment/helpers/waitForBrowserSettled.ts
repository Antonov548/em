import { BrowserEnvironment } from '../types'

/** Waits for browser layout, paint, and queued macrotasks to settle after DOM-affecting e2e actions. */
const waitForBrowserSettled = async (browser: BrowserEnvironment): Promise<void> => {
  await browser.execute(async () => {
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    await new Promise(resolve => setTimeout(resolve))
  })
}

export default waitForBrowserSettled

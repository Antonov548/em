import type { WindowEm } from '../../../initialize'
import { BrowserEnvironment } from '../types'
import waitForBrowserSettled from './waitForBrowserSettled'

/** Waits for TreeCRDT persistence and React's post-paint focus/selection effects after an e2e action. */
const waitForEmIdle = async (browser: BrowserEnvironment): Promise<void> => {
  /** Waits for TreeCRDT writes and materialization work exposed by the app test helpers. */
  const waitForTreecrdtIdle = () =>
    browser.execute(async () => {
      await (window.em as Partial<WindowEm> | undefined)?.testHelpers?.waitForTreecrdtIdle?.()
    })

  // Two passes are intentional: React effects can enqueue persistence after the first idle wait.
  await waitForBrowserSettled(browser)
  await waitForTreecrdtIdle()
  await waitForBrowserSettled(browser)
  await waitForTreecrdtIdle()
  await waitForBrowserSettled(browser)
}

export default waitForEmIdle

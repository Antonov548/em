import waitForBrowserSettledWebdriver from '../../browserEnvironment/helpers/waitForBrowserSettled'
import asBrowserEnvironment from './asBrowserEnvironment'

/** Waits for browser layout, paint, and queued macrotasks to settle after DOM-affecting e2e actions. */
const waitForBrowserSettled = (): Promise<void> => waitForBrowserSettledWebdriver(asBrowserEnvironment())

export default waitForBrowserSettled

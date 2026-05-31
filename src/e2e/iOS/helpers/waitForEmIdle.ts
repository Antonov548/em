import waitForEmIdleWebdriver from '../../browserEnvironment/helpers/waitForEmIdle.js'
import asBrowserEnvironment from './asBrowserEnvironment.js'

/** Waits for TreeCRDT persistence and React's post-paint focus/selection effects after an e2e action. */
const waitForEmIdle = (): Promise<void> => waitForEmIdleWebdriver(asBrowserEnvironment())

export default waitForEmIdle

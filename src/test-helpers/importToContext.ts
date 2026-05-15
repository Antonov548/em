import Thunk from '../@types/Thunk'
import { importTextActionCreator as importText } from '../actions/importText'
import { HOME_TOKEN } from '../constants'
import contextToPath from '../selectors/contextToPath'

type ImportToContextOptions = {
  /** Creates imported text as a child of the destination instead of editing the destination inline. */
  preventInline?: boolean
}

function importToContext(text: string): Thunk
function importToContext(pathUnranked: string[], text: string, options?: ImportToContextOptions): Thunk

/** A thunk that imports text to the given unranked path. */
function importToContext(pathUnranked: string | string[], text?: string, options?: ImportToContextOptions): Thunk {
  const _pathUnranked = typeof pathUnranked === 'string' ? [HOME_TOKEN] : (pathUnranked as string[])
  const _text = typeof pathUnranked === 'string' ? pathUnranked : text!

  return (dispatch, getState) => {
    const path = contextToPath(getState(), _pathUnranked)
    return (
      path &&
      dispatch(
        importText({
          path,
          text: _text,
          preventInline: options?.preventInline,
        }),
      )
    )
  }
}

export default importToContext

/// <reference types="vite/client" />
import type { GladdisApi } from '../../shared/types'

declare global {
  interface Window {
    gladdis: GladdisApi
  }
}

export {}

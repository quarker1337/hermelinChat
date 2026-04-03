/// <reference types="vite/client" />

declare const __APP_VERSION__: string

declare module '*.svg?raw' {
  const content: string
  export default content
}

declare module '*.svg' {
  const url: string
  export default url
}

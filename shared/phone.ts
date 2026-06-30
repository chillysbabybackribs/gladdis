export interface PhoneBridgeStartOptions {
  host?: string
  port?: number
}

export interface PhoneBridgeStatus {
  running: boolean
  host: string
  port: number | null
  appUrl: string | null
  token: string | null
  corsOrigin: string | null
}

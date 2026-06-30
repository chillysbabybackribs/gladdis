export interface PhoneBridgeStartOptions {
  host?: string
  port?: number
}

export interface PhoneBridgeDevice {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number | null
}

export interface PhoneBridgePairResult {
  device: PhoneBridgeDevice
  token: string
  appUrl: string | null
}

export interface PhoneBridgeStatus {
  running: boolean
  host: string
  port: number | null
  appUrl: string | null
  token: string | null
  corsOrigin: string | null
  devices: PhoneBridgeDevice[]
}

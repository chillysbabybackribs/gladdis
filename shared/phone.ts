import type { ChatStreamEvent } from './chat'

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

export type PhoneSocketCommand =
  | {
    type: 'send'
    clientMessageId?: string
    text: string
    conversationId?: string
    modelId?: string
  }
  | {
    type: 'abort'
    requestId: string
  }

export type PhoneSocketEvent =
  | {
    type: 'ready'
  }
  | {
    type: 'status'
    state: 'connected'
  }
  | {
    type: 'ack'
    clientMessageId: string
    requestId: string
    conversationId: string
    assistantMessageId: string
  }
  | {
    type: 'chat'
    event: ChatStreamEvent
  }
  | {
    type: 'error'
    message: string
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

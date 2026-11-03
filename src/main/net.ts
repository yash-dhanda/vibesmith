import { Agent, fetch as undiciFetch } from 'undici'

// Node's built-in fetch gives up after 5 minutes without a byte. Model downloads and slow local models can be silent for
// longer, so everything that talks to a model or downloads one waits as long as it needs.
const patient = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 15_000 })
export const patientFetch = (url: string, init: RequestInit = {}) => undiciFetch(url, { ...(init as object), dispatcher: patient } as never) as unknown as Promise<Response>

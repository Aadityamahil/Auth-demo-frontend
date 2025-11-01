import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import FingerprintJS from '@fingerprintjs/fingerprintjs'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000'

const fpPromise = FingerprintJS.load()

// Device ID generator (device-specific, not browser-specific)
// Uses characteristics that are the same across browsers on the same device
const generateDeviceId = (): string => {
  // Get stable values that are the same across browsers
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || navigator.language || 'en'
  const language = navigator.language || 'en'
  const platform = navigator.platform || (navigator as any).userAgentData?.platform || 'unknown'
  const hardwareConcurrency = String(navigator.hardwareConcurrency || 0)
  const maxTouchPoints = String(navigator.maxTouchPoints || 0)
  
  // Use availWidth/availHeight instead of width/height for consistency
  // Also normalize to reduce window size variations
  const screenWidth = Math.floor((screen.availWidth || screen.width || 0) / 100) * 100
  const screenHeight = Math.floor((screen.availHeight || screen.height || 0) / 100) * 100
  const colorDepth = screen.colorDepth || 24
  const pixelDepth = screen.pixelDepth || screen.colorDepth || 24
  
  // Device-specific components (same across browsers on the same device):
  // Normalize all values to strings for consistent hashing
  const components = [
    `screen:${screenWidth}x${screenHeight}x${colorDepth}x${pixelDepth}`, // Normalized screen specs
    `tz:${timezone}`, // Timezone
    `loc:${locale}`, // Locale
    `lang:${language}`, // Language
    `cpu:${hardwareConcurrency}`, // CPU cores
    `platform:${platform.toLowerCase()}`, // Platform (normalized to lowercase)
    `touch:${maxTouchPoints}`, // Touch support
    // Note: We explicitly EXCLUDE userAgent because it's browser-specific
  ].join('|')
  
  // Log the components for debugging (will help identify what's different)
  console.log('[WEBAUTHN] Device ID components:', {
    components: components.split('|'),
    screenWidth,
    screenHeight,
    timezone,
    platform: platform.toLowerCase(),
  })
  
  // Stable hash function (same input = same output, no time-based randomness)
  let hash = 0
  for (let i = 0; i < components.length; i++) {
    const char = components.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  
  // No Date.now() - we want the same device to always get the same ID
  const deviceId = `device-${Math.abs(hash).toString(16)}`
  console.log('[WEBAUTHN] Generated device ID:', deviceId)
  return deviceId
}

// Get device fingerprint (device-specific, works across browsers)
const getDeviceFingerprint = async (): Promise<string> => {
  // IMPORTANT: FingerprintJS generates browser-specific fingerprints
  // Since we want device-specific binding (same device, different browsers = same ID),
  // we use ONLY device-specific characteristics, NOT browser-specific ones
  
  // This generates the same ID across Chrome, Edge, Firefox, Safari, etc. on the same device
  const deviceId = generateDeviceId()
  
  console.log('[WEBAUTHN] Device fingerprint (device-specific):', deviceId.substring(0, 30) + '...')
  return deviceId
}

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  // base64url helpers
  const bufToBase64url = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf)
    let str = ''
    for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i])
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }
  const base64urlToBuf = (b64url: string): ArrayBuffer => {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
    const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/')
    const str = atob(b64)
    const buf = new ArrayBuffer(str.length)
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i)
    return buf
  }

  const registerPasskey = async () => {
    try {
      if (!email) return toast.error('Enter email')

      // Check WebAuthn support
      if (!window.PublicKeyCredential) {
        return toast.error('WebAuthn not supported in this browser')
      }

      // Check secure context (HTTPS required on iOS Safari unless localhost)
      const isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      if (!isSecureContext) {
        return toast.error('HTTPS required for passkeys. Use localhost or HTTPS.')
      }

      // Safari on iOS requires user interaction context
      // Get device fingerprint for device binding (device-specific, works across browsers)
      const visitorId = await getDeviceFingerprint()
      const regFinalVisitorId = visitorId || generateDeviceId() // Ensure we always have one

      // 1) Get registration options
      const registerStartHeaders: Record<string, string> = {}
      registerStartHeaders['x-fp-visitor-id'] = regFinalVisitorId
      
      const { data: options } = await axios.post(
        `${API_BASE}/webauthn/register/start`,
        { email },
        { 
          withCredentials: true,
          headers: registerStartHeaders,
        }
      )

      // Validate required fields
      if (!options.challenge) {
        throw new Error('Missing challenge in registration options')
      }
      if (!options.rp || !options.rp.id) {
        throw new Error('Missing rp.id in registration options')
      }
      if (!options.user || !options.user.id) {
        throw new Error('Missing user.id in registration options')
      }

      // Convert challenge and user.id to ArrayBuffer
      options.challenge = base64urlToBuf(options.challenge)
      if (options.user && options.user.id) {
        options.user.id = base64urlToBuf(options.user.id)
      }
      if (Array.isArray(options.excludeCredentials)) {
        options.excludeCredentials = options.excludeCredentials.map((cred: any) => ({
          ...cred,
          id: typeof cred.id === 'string' ? base64urlToBuf(cred.id) : cred.id,
        }))
      }

      console.log('[WEBAUTHN] Creating credential with options:', {
        rp: options.rp,
        user: { ...options.user, id: '[...]' },
        challenge_length: options.challenge?.byteLength,
        authenticatorSelection: options.authenticatorSelection,
        pubKeyCredParams: options.pubKeyCredParams,
        hasExtensions: !!options.extensions,
      })

      // 2) Create credential - Safari might need this called directly in user event handler
      const cred = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential
      
      if (!cred || !cred.response) {
        throw new Error('Failed to create credential - no response from authenticator')
      }
      const attObj = (cred.response as AuthenticatorAttestationResponse).attestationObject
      const clientDataJSON = cred.response.clientDataJSON

      const attestationResponse = {
        id: cred.id,
        rawId: bufToBase64url(cred.rawId),
        type: cred.type,
        response: {
          attestationObject: bufToBase64url(attObj),
          clientDataJSON: bufToBase64url(clientDataJSON),
          transports: (cred as any).response.getTransports?.() || [],
        },
      }

      // 3) Send to server for verification & storage (include device fingerprint)
      // Use the visitorId we got at the start
      const registerFinishHeaders: Record<string, string> = {}
      registerFinishHeaders['x-fp-visitor-id'] = regFinalVisitorId
      
      const requestBody = {
        email,
        attestationResponse,
        fpVisitorId: regFinalVisitorId,
      }
      
      console.log('[WEBAUTHN] registerPasskey - Sending request:', {
        hasVisitorId: !!regFinalVisitorId,
        visitorIdPreview: regFinalVisitorId ? `${regFinalVisitorId.substring(0, 30)}...` : 'MISSING',
        bodyKeys: Object.keys(requestBody),
        headerKeys: Object.keys(registerFinishHeaders),
      })
      
      await axios.post(
        `${API_BASE}/webauthn/register/finish`,
        requestBody,
        { 
          withCredentials: true,
          headers: registerFinishHeaders,
        }
      )
      toast.success('Passkey registered for this device')
    } catch (err: any) {
      console.error('[WEBAUTHN] Registration error:', {
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
        response: err?.response?.data,
        status: err?.response?.status,
      })
      
      // Handle specific Safari/WebAuthn errors
      if (err?.name === 'NotAllowedError' || err?.message?.includes('NotAllowedError')) {
        toast.error('Registration cancelled or not supported. Please try again.')
      } else if (err?.name === 'InvalidStateError' || err?.message?.includes('InvalidStateError')) {
        toast.error('A passkey for this account may already exist on this device.')
      } else if (err?.name === 'NotSupportedError' || err?.message?.includes('NotSupportedError')) {
        toast.error('WebAuthn not supported. Please use a modern browser.')
      } else if (err?.name === 'SecurityError' || err?.message?.includes('SecurityError')) {
        toast.error('Security error. Make sure you\'re using HTTPS or localhost.')
      } else if (err?.name === 'TypeError' || err?.message?.includes('TypeError')) {
        toast.error(`Configuration error: ${err?.message || 'Invalid options format'}`)
      } else {
        const errorMsg = err?.response?.data?.message || err?.response?.data?.detail || err?.message || 'Passkey registration failed'
        toast.error(errorMsg)
      }
    }
  }

  const loginWithPasskey = async () => {
    setLoading(true)
    try {
      if (!email) return toast.error('Enter email')

      // Get device fingerprint for device binding (device-specific, works across browsers)
      const visitorId = await getDeviceFingerprint()
      const loginFinalVisitorId = visitorId || generateDeviceId() // Ensure we always have one

      // 1) Get auth options
      const loginStartHeaders: Record<string, string> = {}
      loginStartHeaders['x-fp-visitor-id'] = loginFinalVisitorId
      
      const { data: options } = await axios.post(
        `${API_BASE}/webauthn/login/start`,
        { email },
        { 
          withCredentials: true,
          headers: loginStartHeaders,
        }
      )

      options.challenge = base64urlToBuf(options.challenge)
      if (Array.isArray(options.allowCredentials)) {
        options.allowCredentials = options.allowCredentials.map((cred: any) => ({
          ...cred,
          id: typeof cred.id === 'string' ? base64urlToBuf(cred.id) : cred.id,
        }))
      }

      // 2) Get assertion
      const assertion = (await navigator.credentials.get({ publicKey: options })) as PublicKeyCredential
      const authResp = assertion.response as AuthenticatorAssertionResponse

      const assertionResponse = {
        id: assertion.id,
        type: assertion.type,
        rawId: bufToBase64url(assertion.rawId),
        response: {
          authenticatorData: bufToBase64url(authResp.authenticatorData),
          clientDataJSON: bufToBase64url(authResp.clientDataJSON),
          signature: bufToBase64url(authResp.signature),
          userHandle: authResp.userHandle ? bufToBase64url(authResp.userHandle) : null,
        },
      }

      // Use the visitorId we got at the start
      const loginFinishHeaders: Record<string, string> = {}
      loginFinishHeaders['x-fp-visitor-id'] = loginFinalVisitorId
      
      const requestBody = {
        email,
        assertionResponse,
        fpVisitorId: loginFinalVisitorId,
      }
      
      console.log('[WEBAUTHN] loginWithPasskey - Sending request:', {
        hasVisitorId: !!loginFinalVisitorId,
        visitorIdPreview: loginFinalVisitorId ? `${loginFinalVisitorId.substring(0, 30)}...` : 'MISSING',
        bodyKeys: Object.keys(requestBody),
        headerKeys: Object.keys(loginFinishHeaders),
      })
      
      const { data } = await axios.post(
        `${API_BASE}/webauthn/login/finish`,
        requestBody,
        { 
          withCredentials: true,
          headers: loginFinishHeaders,
        }
      )

      if (data?.verified) {
        toast.success('Device login successful')
        navigate('/dashboard')
      } else {
        toast.error('Device login failed')
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Device login failed')
    } finally {
      setLoading(false)
    }
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const fp = await fpPromise
      const result = await fp.get()
      const visitorId = result.visitorId

      const { data } = await axios.post(
        `${API_BASE}/auth/login`,
        { email, password },
        {
          withCredentials: true,
          headers: { 'x-fp-visitor-id': visitorId },
        }
      )
      toast.success('Logged in')
      sessionStorage.setItem('deviceIdHash', data.deviceIdHash)
      navigate('/dashboard')
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  const onRegister = async () => {
    if (!email || !password) return toast.error('Enter email and password')
    try {
      await axios.post(`${API_BASE}/auth/register`, { email, password })
      toast.success('Registered. Now login.')
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Register failed')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-sm">
        <h1 className="text-2xl font-bold mb-4 text-center">Login</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm mb-1">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              required
            />
          </div>
          <button className="btn w-full" disabled={loading} type="submit">
            {loading ? 'Signing in…' : 'Login'}
          </button>
        </form>
        <div className="mt-3 space-y-2">
          <button onClick={registerPasskey} className="btn w-full" disabled={loading}>
            Register device (passkey)
          </button>
          <button onClick={loginWithPasskey} className="btn w-full" disabled={loading}>
            Login with device (passkey)
          </button>
        </div>
        <button onClick={onRegister} className="mt-3 text-sm text-blue-600 hover:underline">
          Register a demo account
        </button>
      </div>
    </div>
  )
}



import React, { useState } from 'react'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import FingerprintJS from '@fingerprintjs/fingerprintjs'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000'

const fpPromise = FingerprintJS.load()

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
      // Get device fingerprint for device binding
      let visitorId;
      try {
        const fp = await fpPromise
        const result = await fp.get()
        visitorId = result.visitorId
        console.log('[WEBAUTHN] registerPasskey - FingerprintJS visitorId:', visitorId ? `${visitorId.substring(0, 20)}...` : 'MISSING')
        
        if (!visitorId) {
          console.warn('[WEBAUTHN] registerPasskey - No visitorId from FingerprintJS, continuing without device binding')
        }
      } catch (fpError) {
        console.error('[WEBAUTHN] registerPasskey - FingerprintJS error:', fpError)
        // Continue without device fingerprint (will log warning in backend)
      }

      // 1) Get registration options
      const { data: options } = await axios.post(
        `${API_BASE}/webauthn/register/start`,
        { email },
        { 
          withCredentials: true,
          headers: { 'x-fp-visitor-id': visitorId },
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
      const registerFinishHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (visitorId) {
        registerFinishHeaders['x-fp-visitor-id'] = visitorId
      }
      
      await axios.post(
        `${API_BASE}/webauthn/register/finish`,
        { email, attestationResponse, fpVisitorId: visitorId },
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

      // Get device fingerprint for device binding
      let visitorId;
      try {
        const fp = await fpPromise
        const result = await fp.get()
        visitorId = result.visitorId
        console.log('[WEBAUTHN] loginWithPasskey - FingerprintJS visitorId:', visitorId ? `${visitorId.substring(0, 20)}...` : 'MISSING')
        
        if (!visitorId) {
          console.warn('[WEBAUTHN] loginWithPasskey - No visitorId from FingerprintJS, continuing without device binding')
        }
      } catch (fpError) {
        console.error('[WEBAUTHN] loginWithPasskey - FingerprintJS error:', fpError)
        // Continue without device fingerprint (will log warning in backend)
      }

      // 1) Get auth options
      const loginStartHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (visitorId) {
        loginStartHeaders['x-fp-visitor-id'] = visitorId
      }
      
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

      const loginFinishHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
      if (visitorId) {
        loginFinishHeaders['x-fp-visitor-id'] = visitorId
      }
      
      const { data } = await axios.post(
        `${API_BASE}/webauthn/login/finish`,
        { email, assertionResponse, fpVisitorId: visitorId },
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



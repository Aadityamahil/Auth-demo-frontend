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
        <button onClick={onRegister} className="mt-3 text-sm text-blue-600 hover:underline">
          Register a demo account
        </button>
      </div>
    </div>
  )
}



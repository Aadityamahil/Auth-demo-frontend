import { useEffect, useState } from 'react'
import axios from 'axios'
import toast from 'react-hot-toast'
import { useNavigate } from 'react-router-dom'

const API_BASE = import.meta.env.VITE_API_BASE

export default function Dashboard() {
  const [email, setEmail] = useState('')
  const [deviceIdHash, setDeviceIdHash] = useState('')
  const [registeredAt, setRegisteredAt] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    axios
      .get(`${API_BASE}/auth/me`, { withCredentials: true })
      .then(({ data }) => {
        setEmail(data.email)
        setDeviceIdHash(data.deviceIdHash)
        setRegisteredAt(data.registeredAt)
      })
      .catch(() => {
        navigate('/')
      })
  }, [navigate])

  const onLogout = async () => {
    await axios.post(`${API_BASE}/auth/logout`, {}, { withCredentials: true })
    toast.success('Logged out')
    navigate('/')
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <button onClick={onLogout} className="btn">Logout</button>
        </div>
        <div className="mt-4 space-y-2">
          <p><span className="font-semibold">Email:</span> {email}</p>
          <p><span className="font-semibold">Device Registered ✅</span></p>
          <p><span className="font-semibold">Device ID (SHA-256):</span> <span className="font-mono break-all">{deviceIdHash}</span></p>
          {registeredAt && (
            <p><span className="font-semibold">Registered At:</span> {new Date(registeredAt).toLocaleString()}</p>
          )}
        </div>
      </div>
    </div>
  )
}



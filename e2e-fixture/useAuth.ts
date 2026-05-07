import { useState, useEffect } from "react"
import type { Session, AuthResult } from "./types"

export const useAuth = (): Session | null => {
  const [session, setSession] = useState<Session | null>(null)
  useEffect(() => { /* hydrate from storage */ }, [])
  return session
}

export const refreshToken = async (token: string): Promise<AuthResult> => {
  const res = await fetch("/api/refresh", { method: "POST", body: JSON.stringify({ token }) })
  if (!res.ok) return { ok: false, error: { code: "REFRESH_FAILED", message: res.statusText } }
  return { ok: true, session: await res.json() }
}

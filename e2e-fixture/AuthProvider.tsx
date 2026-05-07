import React, { createContext, useContext } from "react"
import { useAuth } from "./useAuth"
import type { Session } from "./types"

const AuthContext = createContext<Session | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = useAuth()
  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>
}

export const useSession = (): Session | null => useContext(AuthContext)

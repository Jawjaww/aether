export interface Session {
  userId: string
  token: string
  expiresAt: number | null
  role: "admin" | "user" | "guest"
}
export interface AuthError { code: string; message: string }
export type AuthResult =
  | { ok: true;  session: Session }
  | { ok: false; error: AuthError }

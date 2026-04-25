import { useState } from 'react'
import { AMBER, SLATE } from '../../theme/index'
import { useAuthStore } from '../../stores/auth'
import { InvertelinSmall } from '../shared/icons'

interface LoginScreenProps {
  faviconHref?: string
}

export const LoginScreen = ({ faviconHref }: LoginScreenProps) => {
  const [password, setPassword] = useState('')
  const { loginError, login, refresh } = useAuthStore()

  const doLogin = async () => {
    await login(password)
    setPassword('')
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: 360,
          border: `1px solid ${SLATE.border}`,
          background: SLATE.surface,
          padding: 16,
          boxShadow: `0 0 30px ${AMBER[900]}55`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <InvertelinSmall size={18} href={faviconHref} />
          <div style={{ color: AMBER[400], fontWeight: 700, fontSize: 12 }}>Login required</div>
        </div>

        <div style={{ color: SLATE.muted, fontSize: 11, marginBottom: 12 }}>
          This UI can spawn a real Hermes terminal. Please authenticate.
        </div>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doLogin()
          }}
          placeholder="Password"
          autoFocus
          style={{
            width: '100%',
            background: SLATE.elevated,
            border: `1px solid ${SLATE.border}`,
            color: SLATE.textBright,
            padding: '10px 10px',
            fontFamily: "'JetBrains Mono',monospace",
            fontSize: 12,
            outline: 'none',
          }}
        />

        {loginError && (
          <div style={{ color: SLATE.danger, fontSize: 11, marginTop: 8 }}>{loginError}</div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <div
            onClick={doLogin}
            style={{
              padding: '9px 12px',
              border: `1px solid ${AMBER[700]}`,
              background: `${AMBER[900]}55`,
              color: AMBER[400],
              cursor: 'pointer',
              fontSize: 12,
              userSelect: 'none',
            }}
          >
            unlock
          </div>
          <div
            onClick={refresh}
            style={{
              padding: '9px 12px',
              border: `1px solid ${SLATE.border}`,
              background: SLATE.elevated,
              color: SLATE.muted,
              cursor: 'pointer',
              fontSize: 12,
              userSelect: 'none',
            }}
          >
            retry
          </div>
        </div>
      </div>
    </div>
  )
}

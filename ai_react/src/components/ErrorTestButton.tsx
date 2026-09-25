import { useState } from 'react'

export function ErrorTestButton({ onInject }: { onInject: (text: string) => void }) {
  const [injecting, setInjecting] = useState(false)

  const handleClick = () => {
    const errorMessage = '⚠️ TEST-FEHLER: Simulierter Fehler im Chat zur Überprüfung des Fehlerhandlings.'
    setInjecting(true)
    onInject(errorMessage)
    setTimeout(() => setInjecting(false), 1500)
  }

  return (
    <button
      onClick={handleClick}
      disabled={injecting}
      style={{
        margin: '12px 20px',
        padding: '8px 16px',
        backgroundColor: '#dc2626',
        color: '#fff',
        border: '1px solid #f87171',
        borderRadius: '6px',
        cursor: injecting ? 'wait' : 'pointer',
        fontSize: '13px',
        fontWeight: '600',
        transition: 'all 0.2s ease',
      }}
    >
      {injecting ? '⏳ Wird injiziert…' : '🧪 Fehler injizieren'}
    </button>
  )
}
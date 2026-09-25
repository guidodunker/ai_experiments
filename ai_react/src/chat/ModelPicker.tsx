const SUGGESTIONS = [
  '~anthropic/claude-haiku-latest',
  '~anthropic/claude-sonnet-latest',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.6',
]

export function ModelPicker({
  model,
  onChange,
  disabled,
}: {
  model: string
  onChange: (model: string) => void
  disabled: boolean
}) {
  return (
    <span className="model-picker">
      <input
        list="model-suggestions"
        value={model}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        spellCheck={false}
        title="OpenRouter model id"
      />
      <datalist id="model-suggestions">
        {SUGGESTIONS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </span>
  )
}

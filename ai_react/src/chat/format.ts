// OpenRouter costs are tiny fractions of a dollar; show enough significant
// digits to be meaningful without scientific notation.
export function formatUsd(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(6)}`
}

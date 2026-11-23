import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDemo } from '../src/demo.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const setting = process.env.DEMO_TARGET?.trim()

if (setting === undefined || setting === '') {
  console.error('DEMO_TARGET fehlt, z. B.: $env:DEMO_TARGET="C:\\workspace\\tests\\bugfix_demo"; npm run demo:init')
  process.exitCode = 2
} else {
  const target = resolve(ROOT, setting)
  try {
    await initDemo(join(ROOT, 'demo'), target)
    console.error(`Demo-Repo angelegt: ${target}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

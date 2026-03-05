import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_ROOT = path.resolve(__dirname, '../../templates')
const OMITTED_TEMPLATE_ENTRIES = new Set(['artifacts', 'cache', 'node_modules', 'dist'])

export function resolveTemplate(name) {
  const templatePath = path.join(TEMPLATE_ROOT, name)
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Unknown template "${name}"`)
  }
  return templatePath
}

function copyRecursive(source, target) {
  const stat = fs.statSync(source)

  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry))
    }
    return
  }

  fs.copyFileSync(source, target)
}

export function copyTemplate(name, destination) {
  const source = resolveTemplate(name)

  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true })
  }

  const existing = fs.readdirSync(destination)
  if (existing.length > 0) {
    throw new Error(`Destination is not empty: ${destination}`)
  }

  for (const entry of fs.readdirSync(source)) {
    if (OMITTED_TEMPLATE_ENTRIES.has(entry)) {
      continue
    }
    copyRecursive(path.join(source, entry), path.join(destination, entry))
  }
}

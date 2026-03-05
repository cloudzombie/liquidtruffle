import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini'
const DEFAULT_CODEX_MODEL = process.env.LIQUIDTRUFFLE_CODEX_MODEL || process.env.CODEX_MODEL || ''
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

const statusCache = {
  expiresAt: 0,
  value: null,
}

const STRUCTURED_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    fileProposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: {
            type: 'string',
            enum: ['workspace', 'companion'],
          },
          path: { type: 'string' },
          reason: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['scope', 'path', 'reason', 'content'],
      },
    },
    jobRequests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaceName: { type: 'string' },
          action: {
            type: 'string',
            enum: ['install', 'doctor', 'compile', 'test', 'deploy'],
          },
          network: {
            type: 'string',
            enum: ['hyperevm', 'hyperevm-testnet'],
          },
          reason: { type: 'string' },
          runNow: { type: 'boolean' },
        },
        required: ['workspaceName', 'action', 'network', 'reason', 'runNow'],
      },
    },
    companionFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['title', 'detail'],
      },
    },
  },
  required: ['message', 'fileProposals', 'jobRequests', 'companionFindings'],
}

function safeJson(value) {
  return JSON.stringify(value, (_key, nextValue) =>
    typeof nextValue === 'bigint' ? nextValue.toString() : nextValue
  )
}

function extractOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim()
  }

  const texts = []
  for (const item of response?.output || []) {
    if (item.type !== 'message') {
      continue
    }

    for (const content of item.content || []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
      if (content.type === 'text' && typeof content.text === 'string') {
        texts.push(content.text)
      }
    }
  }

  return texts.join('\n').trim()
}

async function createResponse({
  apiKey,
  model,
  instructions,
  input,
  previousResponseId,
  tools,
}) {
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      previous_response_id: previousResponseId,
      tools,
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message =
      payload?.error?.message || `OpenAI Responses request failed with status ${response.status}`
    throw new Error(message)
  }

  return payload
}

function getFunctionCalls(response) {
  return (response?.output || []).filter((item) => item.type === 'function_call')
}

async function runOpenAiTurn({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  instructions,
  input,
  previousResponseId,
  tools,
  handlers,
  maxSteps = 8,
}) {
  let pendingInput = input
  let previousId = previousResponseId
  let lastResponse = null
  const usedTools = []

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await createResponse({
      apiKey,
      model,
      instructions,
      input: pendingInput,
      previousResponseId: previousId,
      tools,
    })

    lastResponse = response
    const calls = getFunctionCalls(response)
    if (!calls.length) {
      return {
        provider: 'openai',
        response,
        previousResponseId: response.id,
        outputText: extractOutputText(response),
        usedTools,
        fileProposals: [],
        jobRequests: [],
        companionFindings: [],
      }
    }

    const outputs = []
    for (const call of calls) {
      const handler = handlers[call.name]
      if (!handler) {
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: safeJson({ error: `Unknown tool: ${call.name}` }),
        })
        continue
      }

      let args = {}
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch (error) {
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: safeJson({ error: `Invalid tool arguments: ${String(error.message || error)}` }),
        })
        continue
      }

      try {
        const result = await handler(args)
        usedTools.push({
          name: call.name,
          args,
        })
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: safeJson(result),
        })
      } catch (error) {
        usedTools.push({
          name: call.name,
          args,
          error: String(error.message || error),
        })
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: safeJson({ error: String(error.message || error) }),
        })
      }
    }

    previousId = response.id
    pendingInput = outputs
  }

  return {
    provider: 'openai',
    response: lastResponse,
    previousResponseId: lastResponse?.id || previousId,
    outputText: extractOutputText(lastResponse),
    usedTools,
    fileProposals: [],
    jobRequests: [],
    companionFindings: [],
  }
}

function runProcess(command, args, { cwd, env, input, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with code ${code}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`.trim()
          )
        )
        return
      }
      resolve({ stdout, stderr })
    })

    if (typeof input === 'string' && input.length) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

function buildCodexPrompt({
  instructions,
  history = [],
  message,
  workspaceName,
  network,
  context = {},
}) {
  const transcript = history
    .slice(-8)
    .map((entry) => `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.text}`)
    .join('\n\n')

  return [
    instructions,
    '',
    'You are running inside LiquidTruffle as the in-app copilot.',
    'You may inspect files, search code, and query local HTTP endpoints.',
    'Do not edit files yourself in this mode.',
    'Do not run install, doctor, compile, test, or deploy yourself in this mode.',
    'If a file change is needed, return it in fileProposals with the full next file content.',
    'If a command job should run, return it in jobRequests. Set runNow=true only when the user explicitly asked you to run it now.',
    'When a structured field does not apply, use an empty string rather than omitting it.',
    'Use scope="workspace" for the active LiquidTruffle workspace and scope="companion" for the configured companion app in the parent repo.',
    'Use companionFindings for concrete companion-app observations or deployment handoff notes.',
    'Do not hallucinate files, commands, balances, deployments, test results, contract addresses, or chain state.',
    'If a claim depends on the filesystem, commands, or RPC state, inspect it first.',
    'Keep your answer concise and operational.',
    workspaceName ? `Active workspace: ${workspaceName}` : 'Active workspace: none selected.',
    network ? `Selected network: ${network}` : 'Selected network: none supplied.',
    `Runtime context JSON:\n${safeJson(context)}`,
    transcript ? `Conversation so far:\n${transcript}` : 'Conversation so far: none.',
    `New user message:\n${message}`,
  ].join('\n')
}

function parseCodexEvent(line) {
  if (!line || line[0] !== '{') {
    return null
  }

  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function parseCodexOutput(stdout) {
  const usedTools = []
  const messages = []

  for (const rawLine of stdout.split(/\r?\n/)) {
    const event = parseCodexEvent(rawLine.trim())
    if (!event) {
      continue
    }

    if (event.type !== 'item.completed') {
      continue
    }

    const item = event.item || {}
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      messages.push(item.text.trim())
      continue
    }

    if (item.type === 'command_execution') {
      usedTools.push({
        name: 'command_execution',
        command: item.command || '',
        exitCode: item.exit_code,
      })
      continue
    }

    if (item.type && item.type !== 'reasoning') {
      usedTools.push({
        name: item.type,
      })
    }
  }

  return {
    outputText: messages[messages.length - 1] || '',
    usedTools,
  }
}

function normalizeStructuredResponse(value) {
  const payload = value && typeof value === 'object' ? value : {}
  return {
    message:
      typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : 'No response text returned.',
    fileProposals: Array.isArray(payload.fileProposals) ? payload.fileProposals : [],
    jobRequests: Array.isArray(payload.jobRequests) ? payload.jobRequests : [],
    companionFindings: Array.isArray(payload.companionFindings) ? payload.companionFindings : [],
  }
}

function parseStructuredPayload(text) {
  const value = String(text || '').trim()
  if (!value) {
    return {}
  }

  try {
    return JSON.parse(value)
  } catch {
    const fencedJsonMatch = value.match(/```json\s*([\s\S]*?)```/i)
    if (fencedJsonMatch?.[1]) {
      try {
        return JSON.parse(fencedJsonMatch[1].trim())
      } catch {
        return null
      }
    }

    return null
  }
}

async function getCodexStatus({ force = false } = {}) {
  const now = Date.now()
  if (!force && statusCache.value && statusCache.expiresAt > now) {
    return statusCache.value
  }

  try {
    const { stdout, stderr } = await runProcess('codex', ['login', 'status'], {
      timeoutMs: 15_000,
    })
    const output = `${stdout}\n${stderr}`.trim()
    const value = {
      configured: /logged in/i.test(output),
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL || 'default',
      detail: output || 'Codex login detected.',
    }
    statusCache.value = value
    statusCache.expiresAt = now + 15_000
    return value
  } catch (error) {
    const value = {
      configured: false,
      provider: 'codex',
      model: DEFAULT_CODEX_MODEL || 'default',
      detail: String(error.message || error),
    }
    statusCache.value = value
    statusCache.expiresAt = now + 5_000
    return value
  }
}

async function runCodexTurn({
  instructions,
  history = [],
  message,
  cwd,
  addDirs = [],
  workspaceName,
  network,
  context = {},
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidtruffle-codex-'))
  const schemaPath = path.join(tempRoot, 'assistant-schema.json')
  fs.writeFileSync(schemaPath, JSON.stringify(STRUCTURED_RESPONSE_SCHEMA), 'utf8')

  const args = [
    'exec',
    '--skip-git-repo-check',
    '-C',
    cwd,
    '--output-schema',
    schemaPath,
    '-c',
    'approval_policy="never"',
    '-s',
    'danger-full-access',
    '--json',
    '-',
  ]

  if (DEFAULT_CODEX_MODEL) {
    args.splice(1, 0, '-m', DEFAULT_CODEX_MODEL)
  }

  for (const directory of addDirs) {
    args.splice(args.length - 2, 0, '--add-dir', directory)
  }

  const prompt = buildCodexPrompt({
    instructions,
    history,
    message,
    workspaceName,
    network,
    context,
  })
  try {
    const { stdout, stderr } = await runProcess('codex', args, {
      cwd,
      input: prompt,
      timeoutMs: 600_000,
    })

    const parsedEvents = parseCodexOutput(stdout)
    const parsedStructured = parseStructuredPayload(parsedEvents.outputText)
    const structured = normalizeStructuredResponse(parsedStructured || {})
    const fallbackMessage =
      String(parsedEvents.outputText || '').trim() || String(stderr || '').trim()

    return {
      provider: 'codex',
      previousResponseId: null,
      outputText:
        structured.message === 'No response text returned.' && fallbackMessage
          ? fallbackMessage
          : structured.message,
      usedTools: parsedEvents.usedTools,
      fileProposals: structured.fileProposals,
      jobRequests: structured.jobRequests,
      companionFindings: structured.companionFindings,
      stderr,
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

export async function runAssistantTurn(options) {
  const codexStatus = await getCodexStatus()
  if (codexStatus.configured) {
    return runCodexTurn(options)
  }

  if (process.env.OPENAI_API_KEY) {
    return runOpenAiTurn({
      ...options,
      apiKey: process.env.OPENAI_API_KEY,
    })
  }

  throw new Error(
    'No local Codex login was found and OPENAI_API_KEY is not configured for the LiquidTruffle API runtime.'
  )
}

export async function getAssistantDefaults() {
  const codexStatus = await getCodexStatus()
  if (codexStatus.configured) {
    return codexStatus
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      configured: true,
      provider: 'openai',
      model: DEFAULT_OPENAI_MODEL,
      detail: 'Using OPENAI_API_KEY for the assistant runtime.',
    }
  }

  return {
    configured: false,
    provider: 'none',
    model: null,
    detail: codexStatus.detail || 'No local Codex login or OPENAI_API_KEY was found.',
  }
}

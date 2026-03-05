const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini'
const RESPONSES_URL = 'https://api.openai.com/v1/responses'

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

export async function runAssistantTurn({
  apiKey,
  model = DEFAULT_MODEL,
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
        response,
        previousResponseId: response.id,
        outputText: extractOutputText(response),
        usedTools,
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
    response: lastResponse,
    previousResponseId: lastResponse?.id || previousId,
    outputText: extractOutputText(lastResponse),
    usedTools,
  }
}

export function getAssistantDefaults() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    model: DEFAULT_MODEL,
  }
}

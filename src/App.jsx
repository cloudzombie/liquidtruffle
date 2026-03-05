import { useEffect, useMemo, useRef, useState } from 'react'

const NETWORK_OPTIONS = [
  { key: 'hyperevm', label: 'HyperEVM Mainnet' },
  { key: 'hyperevm-testnet', label: 'HyperEVM Testnet' },
]

const ACTIONS = [
  { id: 'install', label: 'Install', summary: 'Hydrate workspace dependencies if you want a local node_modules.' },
  { id: 'doctor', label: 'Doctor', summary: 'Check for missing config, chain constraints, and HyperEVM caveats.' },
  { id: 'compile', label: 'Compile', summary: 'Build artifacts from the active workspace and refresh the contract registry.' },
  { id: 'test', label: 'Test', summary: 'Run the Hardhat suite without leaving the interface.' },
  { id: 'deploy', label: 'Deploy', summary: 'Broadcast the starter deployment script to the selected HyperEVM network.' },
]

const ASSISTANT_STARTERS = [
  'Create a new HyperEVM workspace for a token launch project and tell me the next steps.',
  'Inspect the active workspace and tell me what is blocking a testnet deploy.',
  'Compile the active workspace and summarize any issues precisely.',
  'Prepare the active workspace for HyperEVM testnet launch and tell me what you changed.',
]

function actionMeta(actionId) {
  return ACTIONS.find((action) => action.id === actionId) || {
    id: actionId,
    label: actionId,
    summary: '',
  }
}

function companionLabel(companion) {
  return companion?.label || 'Companion'
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString('en-US')
}

function formatVolume(value) {
  const number = Number(value || 0)
  if (number >= 1_000_000_000) {
    return `$${(number / 1_000_000_000).toFixed(2)}B`
  }
  if (number >= 1_000_000) {
    return `$${(number / 1_000_000).toFixed(2)}M`
  }
  if (number >= 1_000) {
    return `$${(number / 1_000).toFixed(1)}K`
  }
  return `$${number.toFixed(0)}`
}

function pickDefaultFile(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return ''
  }

  const preferred = files.find((file) => file.startsWith('contracts/'))
  if (preferred) {
    return preferred
  }

  return files.find((file) => file === 'README.md') || files[0]
}

function lastDeploymentAddress(workspace) {
  const latestNetwork = workspace?.deployments?.find((entry) => entry.deployments?.length)
  if (!latestNetwork) {
    return ''
  }

  const deployment = latestNetwork.deployments[latestNetwork.deployments.length - 1]
  return deployment?.address || ''
}

function latestWorkspaceDeployment(workspace) {
  const latestNetwork = workspace?.deployments?.find((entry) => entry.deployments?.length)
  if (!latestNetwork) {
    return null
  }

  const deployment = latestNetwork.deployments[latestNetwork.deployments.length - 1]
  if (!deployment) {
    return null
  }

  return {
    network: latestNetwork.network,
    ...deployment,
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const data = await response
    .json()
    .catch(() => ({ error: `Request failed: ${response.status}` }))

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`)
  }

  return data
}

function SectionEyebrow({ children }) {
  return <div className="lt-eyebrow">{children}</div>
}

function StatusBadge({ tone = 'neutral', children }) {
  return <span className={`lt-status ${tone}`}>{children}</span>
}

function KeyStatusLight({ configured, text }) {
  return (
    <span className={`key-status-light ${configured ? 'live' : 'error'}`}>
      <span className="key-status-dot" aria-hidden="true" />
      <span>{text}</span>
    </span>
  )
}

function MetricPill({ label, value, tone = 'neutral' }) {
  return (
    <div className={`metric-pill tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function NetworkCard({ item }) {
  const live = item.state === 'ready'
  return (
    <article className={`lt-panel network-card tone-${live ? 'teal' : 'coral'}`}>
      <div className="panel-topline">
        <div>
          <p className="panel-kicker">{item.label}</p>
          <h3>{item.name}</h3>
        </div>
        <StatusBadge tone={live ? (item.fallbackActive ? 'loading' : 'live') : 'error'}>
          {live ? (item.fallbackActive ? 'Fallback RPC' : 'Live') : 'Unavailable'}
        </StatusBadge>
      </div>

      {live ? (
        <>
          <div className="network-grid">
            <div>
              <span>Block</span>
              <strong>{formatInteger(item.blockNumber)}</strong>
            </div>
            <div>
              <span>Gas</span>
              <strong>{item.gasPrice}</strong>
            </div>
            <div>
              <span>Big block</span>
              <strong>{item.bigBlockGasPrice}</strong>
            </div>
            <div>
              <span>Chain ID</span>
              <strong>{item.chainId}</strong>
            </div>
          </div>
          <div className="network-footer">
            <code>{item.rpcUrl}</code>
            {item.fallbackActive ? <p>Fallback active after probing {item.rpcCandidates?.length || 0} candidates.</p> : null}
            {item.wrappedNative ? <p>Wrapped HYPE: {item.wrappedNative}</p> : <p>No wrapped native preset.</p>}
          </div>
        </>
      ) : (
        <div className="message-box error">{item.error}</div>
      )}
    </article>
  )
}

function MarketTable({ title, eyebrow, columns, rows }) {
  return (
    <article className="lt-panel table-panel">
      <SectionEyebrow>{eyebrow}</SectionEyebrow>
      <h3>{title}</h3>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column) => (
                  <td key={column.key}>{column.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  )
}

function getAssistantStatusMeta(assistant, assistantState) {
  if (!assistant?.configured) {
    return {
      tone: 'error',
      text: 'Unavailable',
      detail: assistant?.detail || 'No assistant backend is configured.',
    }
  }

  if (assistant.provider === 'codex') {
    return {
      tone: assistantState === 'loading' ? 'loading' : 'live',
      text: assistantState === 'loading' ? 'Codex thinking' : 'Ready · Codex login',
      detail: assistant.detail || 'Using the local Codex login on this machine.',
    }
  }

  return {
    tone: assistantState === 'loading' ? 'loading' : 'live',
    text: assistantState === 'loading' ? 'Thinking' : `Ready · ${assistant.model || 'model'}`,
    detail: assistant.detail || 'Using OPENAI_API_KEY for the assistant runtime.',
  }
}

function assistantToolLabel(tool) {
  if (tool?.name === 'command_execution' && tool.command) {
    return tool.command.replace(/^\/bin\/zsh -lc\s+/, '')
  }
  return tool?.name || 'tool'
}

function displayWorkspaceName(name) {
  return String(name || '')
}

function sortWorkspaces(workspaces = []) {
  return [...workspaces].sort((left, right) =>
    String(left?.name || '').localeCompare(String(right?.name || ''))
  )
}

function statusToneFromJob(jobStatus) {
  if (jobStatus === 'completed') {
    return 'live'
  }
  if (jobStatus === 'failed') {
    return 'error'
  }
  if (jobStatus === 'running' || jobStatus === 'planned') {
    return 'loading'
  }
  return 'neutral'
}

function formatLogTimestamp(value) {
  if (!value) {
    return 'No timestamp'
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return String(value)
  }
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function extractJobLogOutput(job) {
  return String(job?.output || job?.outputTail || job?.stdout || job?.stderr || job?.command || '').trim()
}

function outputTailFromSnapshot(job, maxLines = 60) {
  return String(job?.output || '')
    .split('\n')
    .slice(-maxLines)
    .join('\n')
    .trim()
}

function countOutputLines(output) {
  const text = String(output || '').trim()
  if (!text) {
    return 0
  }
  return text.split(/\r?\n/).length
}

function AssistantContextGrid({ workspaceName, networkChoice, companionApp, deployment }) {
  return (
    <div className="assistant-context">
      <div>
        <span>Active workspace</span>
        <strong>{workspaceName || 'None selected'}</strong>
      </div>
      <div>
        <span>Target network</span>
        <strong>{NETWORK_OPTIONS.find((item) => item.key === networkChoice)?.label || networkChoice}</strong>
      </div>
      <div>
        <span>{companionLabel(companionApp)} app</span>
        <strong>{companionApp?.running ? companionApp.title || companionApp.url || 'Running' : 'Unavailable'}</strong>
      </div>
      <div>
        <span>Latest deployment</span>
        <strong>{deployment?.address || 'No deployment yet'}</strong>
      </div>
    </div>
  )
}

function AssistantProposalCard({ proposal, onApply, onDiscard, busy, companionApp }) {
  return (
    <article className={`assistant-artifact-card proposal-card status-${proposal.status}`}>
      <div className="assistant-artifact-head">
        <div>
          <strong>{proposal.path}</strong>
          <span>{proposal.scope === 'companion' ? `${companionLabel(companionApp)} app draft` : 'Workspace draft'}</span>
        </div>
        <StatusBadge
          tone={
            proposal.status === 'applied'
              ? 'live'
              : proposal.status === 'discarded'
                ? 'neutral'
                : proposal.status === 'rejected'
                  ? 'error'
                  : proposal.status === 'noop'
                    ? 'neutral'
                    : 'loading'
          }
        >
          {proposal.status}
        </StatusBadge>
      </div>
      <p className="assistant-artifact-reason">{proposal.reason}</p>
      {proposal.error ? <div className="message-box error">{proposal.error}</div> : null}
      <pre className="assistant-diff">{proposal.diff || 'No diff available.'}</pre>
      <div className="assistant-actions">
        <button
          className="lt-button lt-button-solid"
          onClick={() => onApply(proposal)}
          disabled={
            busy ||
            !['pending', 'noop'].includes(proposal.status)
          }
        >
          {proposal.status === 'noop' ? 'Apply anyway' : 'Apply draft'}
        </button>
        <button
          className="lt-button lt-button-ghost"
          onClick={() => onDiscard(proposal)}
          disabled={busy || !['pending', 'noop'].includes(proposal.status)}
        >
          Discard
        </button>
      </div>
    </article>
  )
}

function AssistantJobCard({ job, onRun, busy, showOutput = true }) {
  return (
    <article className={`assistant-artifact-card job-card status-${job.status}`}>
      <div className="assistant-artifact-head">
        <div>
          <strong>{job.action}</strong>
          <span>{job.workspaceName || job.workspace || 'No workspace'} · {job.network || 'No network'}</span>
        </div>
        <StatusBadge tone={statusToneFromJob(job.status)}>
          {job.status}
        </StatusBadge>
      </div>
      {job.reason ? <p className="assistant-artifact-reason">{job.reason}</p> : null}
      {job.error ? <div className="message-box error">{job.error}</div> : null}
      {showOutput && job.outputTail ? <pre className="assistant-job-output">{job.outputTail}</pre> : null}
      <div className="assistant-actions">
        <button className="lt-button lt-button-ghost" onClick={() => onRun(job)} disabled={busy}>
          {job.status === 'planned' ? 'Run now' : 'Rerun'}
        </button>
      </div>
    </article>
  )
}

function QuickActionStrip({ title, subtitle, actions, onRun, busyKey, disabled, actionKeyPrefix }) {
  return (
    <div className="assistant-control-strip">
      <div className="assistant-control-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="assistant-chip-row">
        {actions.map((actionId) => {
          const action = actionMeta(actionId)
          const actionKey = `${actionKeyPrefix}:${action.id}`
          return (
            <button
              key={action.id}
              className="starter-chip assistant-chip"
              title={action.summary}
              onClick={() => onRun(action.id)}
              disabled={disabled || busyKey === actionKey}
            >
              {busyKey === actionKey ? `${action.label}...` : action.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CompanionProfileCard({
  profile,
  selectedWorkspace,
  networkChoice,
  busyKey,
  onSelectWorkspace,
  onRunAction,
  onRunTakeover,
}) {
  const effectiveWorkspaceName = profile.workspaceName || selectedWorkspace || ''
  const workspaceReady = Boolean(profile.workspaceExists || effectiveWorkspaceName)
  const workspaceActive = Boolean(effectiveWorkspaceName) && selectedWorkspace === effectiveWorkspaceName
  const takeoverActions = Array.isArray(profile.autopilotActions) ? profile.autopilotActions : []
  const flowKey = `companion-flow:${profile.id}`
  return (
    <article className="assistant-companion-card">
      <div className="assistant-artifact-head">
        <div>
          <strong>{profile.label}</strong>
          <span>{profile.description || 'Optional companion profile.'}</span>
        </div>
        <StatusBadge tone={profile.running ? 'live' : workspaceReady ? 'neutral' : 'error'}>
          {profile.running ? 'Live' : workspaceReady ? 'Ready' : 'Missing workspace'}
        </StatusBadge>
      </div>

      <div className="assistant-companion-meta">
        <span>Workspace: {effectiveWorkspaceName || 'none selected'}</span>
        <span>Network: {NETWORK_OPTIONS.find((item) => item.key === networkChoice)?.label || networkChoice}</span>
      </div>

      <div className="assistant-chip-row">
        <button
          className={`starter-chip assistant-chip ${workspaceActive ? 'active' : ''}`}
          onClick={() => onSelectWorkspace(profile)}
          disabled={!workspaceReady}
        >
          {workspaceActive
            ? `${profile.label} workspace selected`
            : workspaceReady
              ? `Use ${profile.label} workspace`
              : `Select a workspace`}
        </button>
        {takeoverActions.length ? (
          <button
            className="starter-chip assistant-chip assistant-chip-accent"
            onClick={() => onRunTakeover(profile)}
            disabled={!workspaceReady || busyKey === flowKey}
          >
            {busyKey === flowKey ? `${profile.label} One-Click Takeover...` : `${profile.label} One-Click Takeover`}
          </button>
        ) : null}
        {(profile.actions || []).map((actionId) => {
          const action = actionMeta(actionId)
          const actionKey = `companion:${profile.id}:${action.id}`
          return (
            <button
              key={`${profile.id}-${action.id}`}
              className="starter-chip assistant-chip assistant-chip-accent"
              title={action.summary}
              onClick={() => onRunAction(profile, action.id)}
              disabled={!workspaceReady || busyKey === actionKey}
            >
              {busyKey === actionKey ? `${profile.label} ${action.label}...` : `${profile.label} ${action.label}`}
            </button>
          )
        })}
      </div>

      {Array.isArray(profile.runbook) && profile.runbook.length ? (
        <div className="assistant-runbook">
          <strong>{profile.label} flow</strong>
          <ol>
            {profile.runbook.map((step, index) => (
              <li key={`${profile.id}-runbook-${index}`}>
                <span>{step.title}</span>
                <p>{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {profile.removeHint ? <div className="assistant-companion-note">{profile.removeHint}</div> : null}
    </article>
  )
}

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [dashboardState, setDashboardState] = useState('loading')
  const [dashboardError, setDashboardError] = useState('')
  const [dashboardRevision, setDashboardRevision] = useState(0)

  const [selectedWorkspace, setSelectedWorkspace] = useState('')
  const [workspace, setWorkspace] = useState(null)
  const [workspaceJobs, setWorkspaceJobs] = useState([])
  const [workspaceState, setWorkspaceState] = useState('idle')
  const [workspaceError, setWorkspaceError] = useState('')
  const [workspaceRevision, setWorkspaceRevision] = useState(0)

  const [newWorkspaceName, setNewWorkspaceName] = useState('liquid-lab')
  const [newContractName, setNewContractName] = useState('LaunchVault')
  const [networkChoice, setNetworkChoice] = useState('hyperevm-testnet')

  const [selectedFile, setSelectedFile] = useState('')
  const [fileContent, setFileContent] = useState('')
  const [fileState, setFileState] = useState('idle')
  const [fileDirty, setFileDirty] = useState(false)
  const [fileNotice, setFileNotice] = useState('')

  const [currentJobId, setCurrentJobId] = useState('')
  const [currentJob, setCurrentJob] = useState(null)

  const [preflight, setPreflight] = useState(null)
  const [preflightState, setPreflightState] = useState('idle')
  const [preflightError, setPreflightError] = useState('')

  const [invokeArtifactPath, setInvokeArtifactPath] = useState('')
  const [invokeMode, setInvokeMode] = useState('read')
  const [invokeFunctionName, setInvokeFunctionName] = useState('')
  const [invokeAddress, setInvokeAddress] = useState('')
  const [invokeArgs, setInvokeArgs] = useState('[]')
  const [invokeState, setInvokeState] = useState('idle')
  const [invokeResult, setInvokeResult] = useState('')
  const [invokeError, setInvokeError] = useState('')

  const [probeNetwork, setProbeNetwork] = useState('hyperevm')
  const [probeAddress, setProbeAddress] = useState('0x5555555555555555555555555555555555555555')
  const [probeState, setProbeState] = useState('idle')
  const [probeResult, setProbeResult] = useState(null)
  const [probeError, setProbeError] = useState('')

  const [assistantSessionId, setAssistantSessionId] = useState('')
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantState, setAssistantState] = useState('idle')
  const [assistantError, setAssistantError] = useState('')
  const [assistantMessages, setAssistantMessages] = useState([])
  const [assistantDockOpen, setAssistantDockOpen] = useState(false)
  const [assistantDockMode, setAssistantDockMode] = useState('dock')
  const [assistantActionKey, setAssistantActionKey] = useState('')
  const [activeLogJobId, setActiveLogJobId] = useState('')
  const [logAutoFollow, setLogAutoFollow] = useState(true)
  const logViewportRef = useRef(null)

  useEffect(() => {
    let cancelled = false

    async function loadDashboard() {
      if (!cancelled) {
        setDashboardState((current) => (current === 'ready' ? 'refreshing' : 'loading'))
      }

      try {
        const nextDashboard = await api('/api/dashboard')
        if (cancelled) {
          return
        }
        setDashboard(nextDashboard)
        setDashboardState('ready')
        setDashboardError('')
      } catch (error) {
        if (cancelled) {
          return
        }
        setDashboardState('error')
        setDashboardError(String(error.message || error))
      }
    }

    loadDashboard()
    const timer = window.setInterval(loadDashboard, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [dashboardRevision])

  useEffect(() => {
    const workspaces = sortWorkspaces(dashboard?.workspaces || [])
    if (!workspaces.length) {
      if (selectedWorkspace) {
        setSelectedWorkspace('')
      }
      return
    }

    const preferredCompanionWorkspace = (dashboard?.companionProfiles || []).find(
      (profile) =>
        profile.defaultWorkspace &&
        profile.workspaceName &&
        workspaces.some((item) => item.name === profile.workspaceName)
    )?.workspaceName
    if (!selectedWorkspace || !workspaces.some((item) => item.name === selectedWorkspace)) {
      setSelectedWorkspace(preferredCompanionWorkspace || workspaces[0].name)
    }
  }, [dashboard, selectedWorkspace])

  useEffect(() => {
    if (!selectedWorkspace) {
      setWorkspace(null)
      setWorkspaceJobs([])
      return
    }

    let cancelled = false

    async function loadWorkspace() {
      setWorkspaceState('loading')
      try {
        const [summary, jobsResponse] = await Promise.all([
          api(`/api/workspaces/${selectedWorkspace}`),
          api(`/api/workspaces/${selectedWorkspace}/jobs`),
        ])
        if (cancelled) {
          return
        }
        setWorkspace(summary)
        setWorkspaceJobs(jobsResponse.jobs || [])
        setWorkspaceState('ready')
        setWorkspaceError('')
      } catch (error) {
        if (cancelled) {
          return
        }
        setWorkspace(null)
        setWorkspaceJobs([])
        setWorkspaceState('error')
        setWorkspaceError(String(error.message || error))
      }
    }

    loadWorkspace()
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, workspaceRevision])

  useEffect(() => {
    if (!workspace?.files?.length) {
      setSelectedFile('')
      return
    }

    if (!selectedFile || !workspace.files.includes(selectedFile)) {
      setSelectedFile(pickDefaultFile(workspace.files))
    }
  }, [workspace, selectedFile])

  useEffect(() => {
    if (!selectedWorkspace || !selectedFile) {
      setFileContent('')
      return
    }

    let cancelled = false

    async function loadFile() {
      setFileState('loading')
      try {
        const nextFile = await api(
          `/api/workspaces/${selectedWorkspace}/files?path=${encodeURIComponent(selectedFile)}`
        )
        if (cancelled) {
          return
        }
        setFileContent(nextFile.content)
        setFileDirty(false)
        setFileNotice('')
        setFileState('ready')
      } catch (error) {
        if (cancelled) {
          return
        }
        setFileState('error')
        setFileContent('')
        setFileNotice(String(error.message || error))
      }
    }

    loadFile()
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, selectedFile])

  useEffect(() => {
    if (!selectedWorkspace) {
      setPreflight(null)
      return
    }

    let cancelled = false

    async function loadPreflight() {
      setPreflightState('loading')
      try {
        const nextPreflight = await api(
          `/api/workspaces/${selectedWorkspace}/preflight?network=${encodeURIComponent(networkChoice)}`
        )
        if (cancelled) {
          return
        }
        setPreflight(nextPreflight)
        setPreflightState('ready')
        setPreflightError('')
      } catch (error) {
        if (cancelled) {
          return
        }
        setPreflightState('error')
        setPreflight(null)
        setPreflightError(String(error.message || error))
      }
    }

    loadPreflight()
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, networkChoice, workspaceRevision])

  useEffect(() => {
    if (!currentJobId) {
      return
    }

    let timer = null
    let cancelled = false

    async function pollJob() {
      try {
        const nextJob = await api(`/api/jobs/${currentJobId}`)
        if (cancelled) {
          return
        }

        setCurrentJob(nextJob)
        setWorkspaceJobs((previous) => {
          const next = previous.filter((item) => item.id !== nextJob.id)
          return [nextJob, ...next]
        })

        if (nextJob.status === 'running') {
          timer = window.setTimeout(pollJob, 1200)
          return
        }

        setCurrentJobId('')
        setWorkspaceRevision((value) => value + 1)
        setDashboardRevision((value) => value + 1)
      } catch {
        if (!cancelled) {
          timer = window.setTimeout(pollJob, 1800)
        }
      }
    }

    pollJob()
    return () => {
      cancelled = true
      if (timer) {
        window.clearTimeout(timer)
      }
    }
  }, [currentJobId])

  useEffect(() => {
    if (!assistantDockOpen || assistantDockMode !== 'fullscreen') {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [assistantDockOpen, assistantDockMode])

  useEffect(() => {
    if (!assistantDockOpen || assistantDockMode !== 'fullscreen') {
      return
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setAssistantDockMode('dock')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [assistantDockOpen, assistantDockMode])

  useEffect(() => {
    if (!workspace?.artifacts?.length) {
      setInvokeArtifactPath('')
      return
    }

    if (!workspace.artifacts.some((item) => item.relativePath === invokeArtifactPath)) {
      setInvokeArtifactPath(workspace.artifacts[0].relativePath)
    }
  }, [workspace, invokeArtifactPath])

  useEffect(() => {
    if (workspace && !invokeAddress) {
      const nextAddress = lastDeploymentAddress(workspace)
      if (nextAddress) {
        setInvokeAddress(nextAddress)
      }
    }
  }, [workspace, invokeAddress])

  const activeArtifact = useMemo(() => {
    return workspace?.artifacts?.find((item) => item.relativePath === invokeArtifactPath) || null
  }, [workspace, invokeArtifactPath])

  const availableFunctions = useMemo(() => {
    if (!activeArtifact) {
      return []
    }
    return invokeMode === 'write' ? activeArtifact.writeFunctions : activeArtifact.readFunctions
  }, [activeArtifact, invokeMode])

  useEffect(() => {
    if (!availableFunctions.length) {
      setInvokeFunctionName('')
      return
    }

    if (!availableFunctions.includes(invokeFunctionName)) {
      setInvokeFunctionName(availableFunctions[0])
    }
  }, [availableFunctions, invokeFunctionName])

  async function createWorkspace() {
    const safeName = slugify(newWorkspaceName)
    if (!safeName) {
      setWorkspaceError('Enter a workspace name first.')
      return
    }

    try {
      const nextWorkspace = await api('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: safeName, template: 'bare-hyperevm' }),
      })
      setSelectedWorkspace(nextWorkspace.name)
      setCurrentJob(null)
      setWorkspaceError('')
      setNewWorkspaceName(safeName)
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      setWorkspaceError(String(error.message || error))
    }
  }

  async function saveFile() {
    if (!selectedWorkspace || !selectedFile) {
      return
    }

    try {
      await api(`/api/workspaces/${selectedWorkspace}/files`, {
        method: 'PUT',
        body: JSON.stringify({
          path: selectedFile,
          content: fileContent,
        }),
      })
      setFileDirty(false)
      setFileNotice(`Saved ${selectedFile}`)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      setFileNotice(String(error.message || error))
    }
  }

  async function createContract() {
    if (!selectedWorkspace) {
      setWorkspaceError('Create or select a workspace first.')
      return
    }

    const contractName = String(newContractName || '').replace(/[^A-Za-z0-9_]/g, '')
    if (!contractName) {
      setWorkspaceError('Contract names must be alphanumeric.')
      return
    }

    try {
      const result = await api(`/api/workspaces/${selectedWorkspace}/contracts`, {
        method: 'POST',
        body: JSON.stringify({ contractName }),
      })
      setWorkspaceError('')
      setSelectedFile(result.path)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      setWorkspaceError(String(error.message || error))
    }
  }

  async function runAction(action) {
    if (!selectedWorkspace) {
      setWorkspaceError('Create or select a workspace first.')
      return
    }

    try {
      await runWorkspaceActionWithLiveLogs({
        workspaceName: selectedWorkspace,
        action,
        network: networkChoice,
      })
      setWorkspaceError('')
    } catch (error) {
      setWorkspaceError(String(error.message || error))
    }
  }

  async function runWorkspaceActionWithLiveLogs({
    workspaceName,
    action,
    network,
    reason = '',
    onProgress,
  }) {
    const resolvedWorkspace = String(workspaceName || selectedWorkspace || '').trim()
    if (!resolvedWorkspace) {
      throw new Error('Select a workspace before running jobs.')
    }

    const resolvedNetwork = String(network || networkChoice || 'hyperevm-testnet')
    const started = await api(`/api/workspaces/${resolvedWorkspace}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        network: resolvedNetwork,
        reason,
      }),
    })

    if (resolvedWorkspace !== selectedWorkspace) {
      setSelectedWorkspace(resolvedWorkspace)
    }

    setCurrentJob(started)
    setCurrentJobId(started.id)
    setWorkspaceJobs((previous) => [started, ...previous.filter((item) => item.id !== started.id)])
    setActiveLogJobId(started.id)
    setLogAutoFollow(true)
    if (onProgress) {
      onProgress(started)
    }

    let snapshot = started
    while (snapshot.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 950))
      snapshot = await api(`/api/jobs/${started.id}`)
      setCurrentJob(snapshot)
      setWorkspaceJobs((previous) => [snapshot, ...previous.filter((item) => item.id !== snapshot.id)])
      if (onProgress) {
        onProgress(snapshot)
      }
    }

    return snapshot
  }

  async function runProbe() {
    try {
      setProbeState('loading')
      const result = await api('/api/inspect/address', {
        method: 'POST',
        body: JSON.stringify({
          network: probeNetwork,
          address: probeAddress,
        }),
      })
      setProbeResult(result)
      setProbeError('')
      setProbeState('ready')
    } catch (error) {
      setProbeResult(null)
      setProbeError(String(error.message || error))
      setProbeState('error')
    }
  }

  async function runInvoke() {
    if (!selectedWorkspace || !invokeArtifactPath || !invokeFunctionName) {
      setInvokeError('Pick a workspace, artifact, and function first.')
      return
    }

    let parsedArgs = []
    try {
      parsedArgs = JSON.parse(invokeArgs || '[]')
      if (!Array.isArray(parsedArgs)) {
        throw new Error('Arguments must be a JSON array.')
      }
    } catch (error) {
      setInvokeError(String(error.message || error))
      return
    }

    try {
      setInvokeState('loading')
      const result = await api(`/api/workspaces/${selectedWorkspace}/contracts/invoke`, {
        method: 'POST',
        body: JSON.stringify({
          network: networkChoice,
          artifactPath: invokeArtifactPath,
          address: invokeAddress,
          functionName: invokeFunctionName,
          mode: invokeMode,
          args: parsedArgs,
        }),
      })
      setInvokeResult(safeStringify(result))
      setInvokeError('')
      setInvokeState('ready')
      setDashboardRevision((value) => value + 1)
    } catch (error) {
      setInvokeResult('')
      setInvokeError(String(error.message || error))
      setInvokeState('error')
    }
  }

  async function sendAssistantMessage(seedMessage = assistantInput) {
    const message = String(seedMessage || '').trim()
    if (!message) {
      return
    }

    const nextUserMessage = {
      role: 'user',
      text: message,
    }

    setAssistantMessages((previous) => [...previous, nextUserMessage])
    setAssistantInput('')
    setAssistantState('loading')
    setAssistantError('')

    try {
      const result = await api('/api/assistant', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: assistantSessionId || undefined,
          message,
          workspaceName: selectedWorkspace || undefined,
          network: networkChoice,
        }),
      })

      setAssistantSessionId(result.sessionId || '')
      setAssistantMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: result.message || 'No response text returned.',
          usedTools: result.usedTools || [],
          proposals: result.proposals || [],
          jobs: result.jobs || [],
          companionFindings: result.companionFindings || [],
          companionApp: result.companionApp || null,
        },
      ])
      setAssistantState('ready')
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      const errorMessage = String(error.message || error)
      setAssistantMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: `Copilot request failed: ${errorMessage}`,
          usedTools: [],
          proposals: [],
          jobs: [],
          companionFindings: [],
          companionApp: null,
        },
      ])
      setAssistantError(errorMessage)
      setAssistantState('error')
    }
  }

  function patchAssistantProposal(proposalId, nextProposal) {
    setAssistantMessages((previous) =>
      previous.map((message) => {
        if (!message.proposals?.length) {
          return message
        }
        return {
          ...message,
          proposals: message.proposals.map((proposal) =>
            proposal.id === proposalId ? { ...proposal, ...nextProposal } : proposal
          ),
        }
      })
    )
  }

  function patchAssistantJob(jobId, nextJob) {
    setAssistantMessages((previous) =>
      previous.map((message) => {
        if (!message.jobs?.length) {
          return message
        }
        return {
          ...message,
          jobs: message.jobs.map((job) =>
            job.id === jobId ? { ...job, ...nextJob } : job
          ),
        }
      })
    )
  }

  async function applyAssistantProposal(proposal) {
    if (!assistantSessionId) {
      setAssistantError('No assistant session is active.')
      return
    }

    setAssistantActionKey(`proposal:${proposal.id}`)
    setAssistantError('')

    try {
      const result = await api('/api/assistant/proposals/apply', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: assistantSessionId,
          proposalId: proposal.id,
        }),
      })

      patchAssistantProposal(proposal.id, result.proposal)
      if (result.proposal.scope === 'workspace') {
        if (result.proposal.workspaceName && result.proposal.workspaceName !== selectedWorkspace) {
          setSelectedWorkspace(result.proposal.workspaceName)
        }
        setSelectedFile(result.proposal.path)
      }
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      setAssistantError(String(error.message || error))
    } finally {
      setAssistantActionKey('')
    }
  }

  async function discardAssistantProposal(proposal) {
    if (!assistantSessionId) {
      setAssistantError('No assistant session is active.')
      return
    }

    setAssistantActionKey(`proposal:${proposal.id}`)
    setAssistantError('')

    try {
      const result = await api('/api/assistant/proposals/discard', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: assistantSessionId,
          proposalId: proposal.id,
        }),
      })

      patchAssistantProposal(proposal.id, result.proposal)
    } catch (error) {
      setAssistantError(String(error.message || error))
    } finally {
      setAssistantActionKey('')
    }
  }

  async function runAssistantJob(job) {
    setAssistantActionKey(`job:${job.id}`)
    setAssistantError('')
    patchAssistantJob(job.id, { status: 'running', error: '', outputTail: '' })

    const workspaceName = String(job.workspaceName || selectedWorkspace || '').trim()
    const network = String(job.network || networkChoice || 'hyperevm-testnet')
    if (!workspaceName) {
      patchAssistantJob(job.id, {
        status: 'failed',
        error: 'No workspace was selected for this job.',
      })
      setAssistantError('No workspace was selected for this job.')
      setAssistantActionKey('')
      return
    }

    try {
      const result = await runWorkspaceActionWithLiveLogs({
        workspaceName,
        action: job.action,
        network,
        reason: job.reason || '',
        onProgress: (snapshot) => {
          patchAssistantJob(job.id, {
            status: snapshot.status,
            error: snapshot.error || '',
            outputTail: outputTailFromSnapshot(snapshot),
            command: snapshot.command,
            exitCode: snapshot.exitCode,
            createdAt: snapshot.createdAt,
            startedAt: snapshot.startedAt,
            finishedAt: snapshot.finishedAt,
            workspaceName,
            network,
          })
        },
      })

      if (result.status !== 'completed' && result.error) {
        setAssistantError(result.error)
      }
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      patchAssistantJob(job.id, {
        status: 'failed',
        error: String(error.message || error),
      })
      setAssistantError(String(error.message || error))
    } finally {
      setAssistantActionKey('')
    }
  }

  function appendAssistantJobMessage({ messageText, toolLabel, job, companion }) {
    setAssistantMessages((previous) => [
      ...previous,
      {
        role: 'assistant',
        text: messageText,
        usedTools: toolLabel ? [{ name: toolLabel }] : [],
        proposals: [],
        jobs: [job],
        companionFindings: [],
        companionApp: companion || null,
      },
    ])
  }

  async function runInlineAssistantJob({
    actionKey,
    messageText,
    toolLabel,
    initialJob,
    nextWorkspace,
    companion,
  }) {
    setAssistantDockOpen(true)
    setAssistantActionKey(actionKey)
    setAssistantError('')
    appendAssistantJobMessage({
      messageText,
      toolLabel,
      job: initialJob,
      companion,
    })

    const workspaceName = String(nextWorkspace || initialJob.workspaceName || selectedWorkspace || '').trim()
    const network = String(initialJob.network || networkChoice || 'hyperevm-testnet')
    if (!workspaceName) {
      patchAssistantJob(initialJob.id, {
        status: 'failed',
        error: 'No workspace was selected for this job.',
      })
      setAssistantError('No workspace was selected for this job.')
      setAssistantActionKey('')
      return
    }

    try {
      const result = await runWorkspaceActionWithLiveLogs({
        workspaceName,
        action: initialJob.action,
        network,
        reason: initialJob.reason || messageText,
        onProgress: (snapshot) => {
          patchAssistantJob(initialJob.id, {
            id: initialJob.id,
            status: snapshot.status,
            error: snapshot.error || '',
            outputTail: outputTailFromSnapshot(snapshot),
            command: snapshot.command,
            exitCode: snapshot.exitCode,
            createdAt: snapshot.createdAt,
            startedAt: snapshot.startedAt,
            finishedAt: snapshot.finishedAt,
            workspaceName,
            network,
            reason: initialJob.reason || '',
          })
        },
      })
      if (result.status !== 'completed' && result.error) {
        setAssistantError(result.error)
      }
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    } catch (error) {
      patchAssistantJob(initialJob.id, {
        status: 'failed',
        error: String(error.message || error),
      })
      setAssistantError(String(error.message || error))
    } finally {
      setAssistantActionKey('')
    }
  }

  function selectCompanionWorkspace(profile) {
    const targetWorkspace = String(profile?.workspaceName || selectedWorkspace || '').trim()
    if (!targetWorkspace) {
      setAssistantError('Select a workspace before using companion shortcuts.')
      return
    }
    if (!workspaceOptions.some((item) => item.name === targetWorkspace)) {
      setAssistantError(`Companion workspace \`${targetWorkspace}\` is not available.`)
      return
    }

    setSelectedWorkspace(targetWorkspace)
    setAssistantDockOpen(true)
    setAssistantError('')
  }

  async function runWorkspaceShortcutAction(action) {
    if (!selectedWorkspace) {
      setAssistantDockOpen(true)
      setAssistantError('Select a workspace before running direct copilot actions.')
      return
    }

    const jobId = `direct-workspace:${selectedWorkspace}:${action}:${Date.now()}`
    const reason = `Direct active workspace ${action} action from copilot shortcuts.`
    await runInlineAssistantJob({
      actionKey: `workspace-action:${action}`,
      messageText: `Running ${action} for the active workspace \`${selectedWorkspace}\`.`,
      toolLabel: `workspace ${action}`,
      initialJob: {
        id: jobId,
        action,
        workspaceName: selectedWorkspace,
        network: networkChoice,
        reason,
        status: 'running',
        outputTail: '',
        error: '',
      },
      nextWorkspace: selectedWorkspace,
      companion: dashboard?.companionApp || null,
    })
  }

  async function runCompanionShortcutAction(profile, action) {
    const targetWorkspace = String(profile?.workspaceName || selectedWorkspace || '').trim()
    if (!targetWorkspace) {
      setAssistantDockOpen(true)
      setAssistantError('Select a workspace before running companion actions.')
      return
    }
    if (!workspaceOptions.some((item) => item.name === targetWorkspace)) {
      setAssistantDockOpen(true)
      setAssistantError(`The workspace \`${targetWorkspace}\` is not available.`)
      return
    }

    const jobId = `direct-companion:${profile.id}:${action}:${Date.now()}`
    const reason = `Direct ${profile.label} companion ${action} action from copilot shortcuts.`
    await runInlineAssistantJob({
      actionKey: `companion:${profile.id}:${action}`,
      messageText: `Running ${action} for the ${profile.label} companion workspace \`${targetWorkspace}\`.`,
      toolLabel: `${profile.label.toLowerCase()} ${action}`,
      initialJob: {
        id: jobId,
        action,
        workspaceName: targetWorkspace,
        network: networkChoice,
        reason,
        status: 'running',
        outputTail: '',
        error: '',
      },
      nextWorkspace: targetWorkspace,
      companion: profile,
    })
  }

  async function runCompanionTakeover(profile) {
    const targetWorkspace = String(profile?.workspaceName || selectedWorkspace || '').trim()
    if (!targetWorkspace) {
      setAssistantDockOpen(true)
      setAssistantError('Select a workspace before running companion one-button flow.')
      return
    }
    if (!workspaceOptions.some((item) => item.name === targetWorkspace)) {
      setAssistantDockOpen(true)
      setAssistantError(`The workspace \`${targetWorkspace}\` is not available.`)
      return
    }

    const actions = Array.isArray(profile.autopilotActions) && profile.autopilotActions.length
      ? profile.autopilotActions
      : ['install', 'doctor', 'compile', 'test', 'deploy']
    const flowId = `${profile.id}:${Date.now()}`
    const flowActionKey = `companion-flow:${profile.id}`
    const jobs = actions.map((actionId, index) => ({
      id: `flow:${flowId}:${actionId}:${index + 1}`,
      action: actionId,
      workspaceName: targetWorkspace,
      network: networkChoice,
      reason: `Step ${index + 1}/${actions.length}: ${profile.label} ${actionMeta(actionId).label}`,
      status: 'planned',
      outputTail: '',
      error: '',
    }))

    setAssistantDockOpen(true)
    setAssistantError('')
    setAssistantActionKey(flowActionKey)
    setSelectedWorkspace(targetWorkspace)
    setAssistantMessages((previous) => [
      ...previous,
      {
        role: 'assistant',
        text: `Running ${profile.label} one-click takeover on \`${targetWorkspace}\` (${networkChoice}).`,
        usedTools: [{ name: `${profile.label.toLowerCase()} one-click takeover` }],
        proposals: [],
        jobs,
        companionFindings: [],
        companionApp: profile,
      },
    ])

    let haltError = ''
    let haltedAt = -1
    for (const [index, actionId] of actions.entries()) {
      const jobId = jobs[index].id
      patchAssistantJob(jobId, { status: 'running', error: '', outputTail: '' })

      try {
        const result = await runWorkspaceActionWithLiveLogs({
          workspaceName: targetWorkspace,
          action: actionId,
          network: networkChoice,
          reason: `One-click takeover step ${index + 1}/${actions.length} for ${profile.label}.`,
          onProgress: (snapshot) => {
            patchAssistantJob(jobId, {
              id: jobId,
              status: snapshot.status,
              error: snapshot.error || '',
              outputTail: outputTailFromSnapshot(snapshot),
              command: snapshot.command,
              exitCode: snapshot.exitCode,
              createdAt: snapshot.createdAt,
              startedAt: snapshot.startedAt,
              finishedAt: snapshot.finishedAt,
              workspaceName: targetWorkspace,
              network: networkChoice,
              reason: jobs[index].reason,
            })
          },
        })

        if (result.status !== 'completed') {
          haltError = result.error || `Step ${index + 1} failed.`
          haltedAt = index
          break
        }
      } catch (error) {
        haltError = String(error.message || error)
        haltedAt = index
        patchAssistantJob(jobId, {
          status: 'failed',
          error: haltError,
        })
        break
      }
    }

    if (haltError) {
      for (let index = haltedAt + 1; index < jobs.length; index += 1) {
        patchAssistantJob(jobs[index].id, {
          status: 'skipped',
          error: 'Skipped because an earlier takeover step failed.',
        })
      }
      setAssistantMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: `${profile.label} one-click takeover stopped early: ${haltError}`,
          usedTools: [],
          proposals: [],
          jobs: [],
          companionFindings: [],
          companionApp: profile,
        },
      ])
      setAssistantError(haltError)
    } else {
      const summary = actions
        .map((actionId, index) => `${index + 1}. ${actionMeta(actionId).label}`)
        .join('\n')
      setAssistantMessages((previous) => [
        ...previous,
        {
          role: 'assistant',
          text: `${profile.label} one-click takeover completed.\n${summary}`,
          usedTools: [],
          proposals: [],
          jobs: [],
          companionFindings: [],
          companionApp: profile,
        },
      ])
      setDashboardRevision((value) => value + 1)
      setWorkspaceRevision((value) => value + 1)
    }

    setAssistantActionKey('')
  }

  function toggleAssistantDock() {
    setAssistantDockOpen((current) => {
      const next = !current
      if (!next) {
        setAssistantDockMode('dock')
      }
      return next
    })
  }

  function openAssistantFullscreen() {
    setAssistantDockOpen(true)
    setAssistantDockMode('fullscreen')
  }

  function openAssistantDocked() {
    setAssistantDockOpen(true)
    setAssistantDockMode('dock')
  }

  const workspaceStats = useMemo(() => {
    if (!workspace) {
      return { files: 0, artifacts: 0, deployments: 0 }
    }

    return {
      files: workspace.files.length,
      artifacts: workspace.artifacts.length,
      deployments: workspace.deployments.reduce(
        (count, entry) => count + (entry.deployments?.length || 0),
        0
      ),
    }
  }, [workspace])

  const workspaceOptions = useMemo(() => sortWorkspaces(dashboard?.workspaces || []), [dashboard])
  const latestJob = currentJob || workspaceJobs[0] || null
  const executionJobs = useMemo(() => {
    const jobsById = new Map()
    for (const job of [...workspaceJobs, ...(currentJob ? [currentJob] : [])]) {
      if (!job?.id) {
        continue
      }
      const previous = jobsById.get(job.id)
      jobsById.set(job.id, previous ? { ...previous, ...job } : job)
    }
    return Array.from(jobsById.values()).sort((left, right) =>
      String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
    )
  }, [workspaceJobs, currentJob])
  const primaryCompanion = dashboard?.companionProfiles?.[0] || dashboard?.companionApp || null
  const selectedWorkspaceSummary = workspaceOptions.find((item) => item.name === selectedWorkspace) || null
  const primaryTakeoverProfile = (dashboard?.companionProfiles || [])[0] || null
  const assistantMeta = getAssistantStatusMeta(dashboard?.assistant, assistantState)
  const workspaceKeyConfigured = Boolean(
    selectedWorkspace &&
      (workspace?.name === selectedWorkspace
        ? workspace?.hasPrivateKey
        : selectedWorkspaceSummary?.hasPrivateKey)
  )
  const workspaceKeyTone = workspaceKeyConfigured ? 'live' : 'error'
  const workspaceKeyText = workspaceKeyConfigured ? 'Signer ready' : 'Signer missing'
  const workspaceKeyDetail = selectedWorkspace || 'No workspace selected'
  const latestDeployment = latestWorkspaceDeployment(workspace)
  const activeLogJob = useMemo(() => {
    if (!executionJobs.length) {
      return null
    }
    return executionJobs.find((job) => job.id === activeLogJobId) || executionJobs[0]
  }, [executionJobs, activeLogJobId])
  const activeLogRawOutput = useMemo(() => extractJobLogOutput(activeLogJob), [activeLogJob])
  const activeLogLineCount = useMemo(() => countOutputLines(activeLogRawOutput), [activeLogRawOutput])
  const activeLogUpdatedAt = activeLogJob
    ? formatLogTimestamp(
        activeLogJob.finishedAt ||
          activeLogJob.updatedAt ||
          activeLogJob.startedAt ||
          activeLogJob.createdAt
      )
    : 'No timestamp'
  const activeLogOutput = useMemo(() => {
    if (!activeLogJob) {
      return 'Run install, doctor, compile, test, or deploy to stream logs here.'
    }

    const headerLines = [
      `[job] ${activeLogJob.action || 'job'} :: ${activeLogJob.workspaceName || activeLogJob.workspace || 'workspace'}`,
      `[status] ${activeLogJob.status || 'unknown'}${activeLogJob.exitCode != null ? ` (exit ${activeLogJob.exitCode})` : ''}`,
      `[network] ${activeLogJob.network || networkChoice}`,
      `[started] ${formatLogTimestamp(activeLogJob.startedAt || activeLogJob.createdAt)}`,
    ]
    if (activeLogJob.finishedAt) {
      headerLines.push(`[finished] ${formatLogTimestamp(activeLogJob.finishedAt)}`)
    }
    headerLines.push('')

    if (activeLogRawOutput) {
      return `${headerLines.join('\n')}${activeLogRawOutput}`
    }
    if (activeLogJob.status === 'running') {
      return `${headerLines.join('\n')}Job is running. Waiting for output...`
    }
    return `${headerLines.join('\n')}${activeLogJob.command || 'No output captured for this job.'}`
  }, [activeLogJob, networkChoice, activeLogRawOutput])
  const activeLogMeta = activeLogJob
    ? `${activeLogJob.network || networkChoice} · ${activeLogLineCount} line${activeLogLineCount === 1 ? '' : 's'} · updated ${activeLogUpdatedAt}`
    : 'Run a workspace action to start logging.'
  const chatOnlyMode = true

  useEffect(() => {
    if (!executionJobs.length) {
      if (activeLogJobId) {
        setActiveLogJobId('')
      }
      return
    }
    if (activeLogJobId && executionJobs.some((job) => job.id === activeLogJobId)) {
      return
    }
    const runningJob = executionJobs.find((job) => job.status === 'running')
    setActiveLogJobId((runningJob || executionJobs[0]).id)
  }, [executionJobs, activeLogJobId])

  useEffect(() => {
    const viewport = logViewportRef.current
    if (!viewport || !logAutoFollow) {
      return
    }
    viewport.scrollTop = viewport.scrollHeight
  }, [activeLogJobId, activeLogOutput, logAutoFollow])

  function handleLogViewportScroll(event) {
    const viewport = event.currentTarget
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
    setLogAutoFollow(distanceFromBottom < 28)
  }

  if (chatOnlyMode) {
    return (
      <div className="lt-app chat-only-app">
        <div className="lt-orb lt-orb-one" />
        <div className="lt-orb lt-orb-two" />
        <div className="lt-gridline" />

        <header className="hero-shell chat-only-header">
          <nav className="topbar">
            <div className="brand-lockup">
              <div className="brand-mark">LT</div>
              <div>
                <p>LiquidTruffle</p>
                <span>Copilot Command Center</span>
              </div>
            </div>

            <div className="topbar-links">
              <div className={`topbar-key-pill tone-${workspaceKeyTone}`}>
                <span>Workspace signer</span>
                <KeyStatusLight configured={workspaceKeyConfigured} text={workspaceKeyText} />
                <em>{workspaceKeyDetail}</em>
              </div>
              <StatusBadge tone={assistantMeta.tone}>{assistantMeta.text}</StatusBadge>
            </div>
          </nav>
        </header>

        <main className="content-shell assistant-only-main">
          <section id="copilot" className="section-block assistant-only-block">
            <div className="assistant-split-layout">
              <aside className="lt-panel assistant-main-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Copilot</SectionEyebrow>
                  <h3>LiquidTruffle primary workflow</h3>
                </div>
                <div className="assistant-panel-controls">
                  <StatusBadge tone={assistantMeta.tone}>{assistantMeta.text}</StatusBadge>
                  <KeyStatusLight configured={workspaceKeyConfigured} text={workspaceKeyText} />
                  <button
                    className="lt-button lt-button-ghost assistant-panel-control-button"
                    onClick={() => {
                      setAssistantMessages([])
                      setAssistantSessionId('')
                      setAssistantError('')
                    }}
                  >
                    Reset thread
                  </button>
                </div>
              </div>

              <div className="form-grid assistant-main-toolbar">
                <label className="field">
                  <span>Workspace</span>
                  <select value={selectedWorkspace} onChange={(event) => setSelectedWorkspace(event.target.value)}>
                    {workspaceOptions.map((item) => (
                      <option key={item.name} value={item.name}>
                        {displayWorkspaceName(item.name)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Network</span>
                  <select value={networkChoice} onChange={(event) => setNetworkChoice(event.target.value)}>
                    {NETWORK_OPTIONS.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="assistant-body-left">
                  <div className="assistant-functional-controls">
                    <AssistantContextGrid
                      workspaceName={selectedWorkspace}
                      networkChoice={networkChoice}
                      companionApp={primaryCompanion}
                      deployment={latestDeployment}
                    />

                    {primaryTakeoverProfile ? (
                      <div className="assistant-takeover-strip">
                        <div className="assistant-takeover-copy">
                          <strong>One-button contract flow</strong>
                          <p>
                            1) install + doctor, 2) compile + test, 3) deploy. Copilot runs this sequence
                            against the {primaryTakeoverProfile.label} workspace and halts on first failure.
                          </p>
                        </div>
                        <button
                          className="lt-button lt-button-solid"
                          onClick={() => runCompanionTakeover(primaryTakeoverProfile)}
                          disabled={
                            !primaryTakeoverProfile.workspaceExists ||
                            assistantActionKey === `companion-flow:${primaryTakeoverProfile.id}`
                          }
                        >
                          {assistantActionKey === `companion-flow:${primaryTakeoverProfile.id}`
                            ? `${primaryTakeoverProfile.label} flow running...`
                            : `Run ${primaryTakeoverProfile.label} one-button flow`}
                        </button>
                      </div>
                    ) : null}

                    <div className="assistant-control-stack assistant-control-stack-dock">
                      <QuickActionStrip
                        title="Active workspace actions"
                        subtitle={
                          selectedWorkspace
                            ? `Direct job controls for ${selectedWorkspace}.`
                            : 'Select a workspace to enable direct job controls.'
                        }
                        actions={ACTIONS.map((action) => action.id)}
                        onRun={runWorkspaceShortcutAction}
                        busyKey={assistantActionKey}
                        disabled={!selectedWorkspace}
                        actionKeyPrefix="workspace-action"
                      />

                      {(dashboard?.companionProfiles || []).map((profile) => (
                        <CompanionProfileCard
                          key={profile.id}
                          profile={profile}
                          selectedWorkspace={selectedWorkspace}
                          networkChoice={networkChoice}
                          busyKey={assistantActionKey}
                          onSelectWorkspace={selectCompanionWorkspace}
                          onRunAction={runCompanionShortcutAction}
                          onRunTakeover={runCompanionTakeover}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="assistant-workbench assistant-workbench-chatonly">
                    <div className="assistant-chat-relocated">
                      <strong>Copilot chat moved to floating bubble</strong>
                      <p>
                        Use the chat bubble in the bottom-right corner to keep conversation on top of the app
                        surface while you run jobs and watch terminal logs.
                      </p>
                      <button
                        className="lt-button lt-button-solid"
                        onClick={() => setAssistantDockOpen(true)}
                      >
                        Open copilot bubble
                      </button>
                    </div>
                  </div>
                </div>
              </aside>

                <aside className="lt-panel assistant-terminal-panel assistant-log-shell assistant-terminal-pane">
                  <div className="assistant-terminal-titlebar">
                    <div className="assistant-terminal-dots" aria-hidden="true">
                      <span className="tone-red" />
                      <span className="tone-amber" />
                      <span className="tone-green" />
                    </div>
                    <strong>Workspace Terminal</strong>
                    <span>{activeLogJob ? 'Live stream' : 'Standby'}</span>
                  </div>

                  <div className="assistant-log-head">
                    <div>
                      <SectionEyebrow>Execution Log</SectionEyebrow>
                      <h4>
                        {activeLogJob
                          ? `${activeLogJob.action || 'Job'} · ${activeLogJob.workspaceName || activeLogJob.workspace || selectedWorkspace || 'workspace'}`
                          : 'No job selected'}
                      </h4>
                    </div>
                    <StatusBadge tone={activeLogJob ? statusToneFromJob(activeLogJob.status) : 'neutral'}>
                      {activeLogJob?.status || 'idle'}
                    </StatusBadge>
                  </div>

                  <div className="assistant-log-toolbar">
                    <span>{activeLogMeta}</span>
                    <button
                      type="button"
                      className="starter-chip assistant-chip"
                      onClick={() => setLogAutoFollow((value) => !value)}
                    >
                      {logAutoFollow ? 'Auto-follow on' : 'Auto-follow off'}
                    </button>
                  </div>

                  <div className="assistant-log-jobs">
                    {executionJobs.length ? (
                      executionJobs.slice(0, 8).map((job) => (
                        <button
                          key={job.id}
                          type="button"
                          className={`assistant-log-job ${activeLogJob?.id === job.id ? 'active' : ''}`}
                          onClick={() => {
                            setActiveLogJobId(job.id)
                            setLogAutoFollow(true)
                          }}
                        >
                          <strong>{job.action || 'job'}</strong>
                          <span>{job.workspaceName || job.workspace || 'workspace'} · {job.network || networkChoice}</span>
                        </button>
                      ))
                    ) : (
                      <div className="assistant-empty assistant-log-empty">No jobs yet.</div>
                    )}
                  </div>

                  <pre
                    ref={logViewportRef}
                    className="assistant-log-stream"
                    onScroll={handleLogViewportScroll}
                  >
                    {activeLogOutput}
                  </pre>
                </aside>
              </div>
          </section>
        </main>

        <div className={`assistant-dock ${assistantDockOpen ? 'open' : 'closed'} docked assistant-chat-bubble-dock`}>
          <div className="assistant-dock-launchers">
            <button
              className="assistant-dock-toggle assistant-siri-bubble"
              onClick={toggleAssistantDock}
              aria-expanded={assistantDockOpen}
              aria-label={assistantDockOpen ? 'Hide copilot chat bubble' : 'Open copilot chat bubble'}
            >
              <span className="assistant-siri-orb" aria-hidden="true">
                <span className="assistant-siri-core" />
              </span>
              <span className="assistant-siri-text">
                <span>Copilot</span>
                <strong>{assistantDockOpen ? 'Listening' : 'Tap to chat'}</strong>
              </span>
            </button>
          </div>

          {assistantDockOpen ? (
            <aside className="lt-panel assistant-dock-panel assistant-chat-bubble-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Copilot Chat</SectionEyebrow>
                  <h3>Floating chat surface</h3>
                </div>
                <div className="assistant-panel-controls">
                  <StatusBadge tone={assistantMeta.tone}>{assistantMeta.text}</StatusBadge>
                  <button
                    className="lt-button lt-button-ghost assistant-panel-control-button"
                    onClick={() => {
                      setAssistantMessages([])
                      setAssistantSessionId('')
                      setAssistantError('')
                    }}
                  >
                    Reset
                  </button>
                </div>
              </div>

              <div className="assistant-chat-shell">
                <div className="assistant-thread">
                  {assistantMessages.length ? (
                    assistantMessages.map((message, index) => (
                      <article
                        key={`${message.role}-${index}`}
                        className={`assistant-message ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                      >
                        <header>
                          <strong>{message.role === 'assistant' ? 'LiquidTruffle Copilot' : 'You'}</strong>
                        </header>
                        <p>{message.text}</p>
                        {message.companionFindings?.length ? (
                          <div className="assistant-findings">
                            {message.companionFindings.map((finding, findingIndex) => (
                              <div key={`${finding.title}-${findingIndex}`} className="assistant-finding">
                                <strong>{finding.title}</strong>
                                <span>{finding.detail}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.usedTools?.length ? (
                          <div className="assistant-tools">
                            {message.usedTools.map((tool, toolIndex) => (
                              <span key={`${assistantToolLabel(tool)}-${toolIndex}`}>
                                {assistantToolLabel(tool)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {message.proposals?.length ? (
                          <div className="assistant-artifact-stack">
                            {message.proposals.map((proposal) => (
                              <AssistantProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                onApply={applyAssistantProposal}
                                onDiscard={discardAssistantProposal}
                                busy={assistantActionKey === `proposal:${proposal.id}`}
                                companionApp={primaryCompanion}
                              />
                            ))}
                          </div>
                        ) : null}
                        {message.jobs?.length ? (
                          <div className="assistant-artifact-stack">
                            {message.jobs.map((job) => (
                              <AssistantJobCard
                                key={job.id}
                                job={job}
                                onRun={runAssistantJob}
                                busy={assistantActionKey === `job:${job.id}`}
                                showOutput={false}
                              />
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <div className="assistant-empty">
                      Ask for analysis, diffs, and repo-aware guidance while keeping the terminal visible.
                    </div>
                  )}
                </div>

                <label className="field assistant-composer-field">
                  <span>Ask the copilot</span>
                  <textarea
                    className="assistant-input"
                    value={assistantInput}
                    onChange={(event) => setAssistantInput(event.target.value)}
                    placeholder="Inspect the current workspace, compile it, and tell me exactly what happened."
                    spellCheck="false"
                  />
                </label>

                <div className="assistant-actions">
                  <button
                    className="lt-button lt-button-solid"
                    onClick={() => sendAssistantMessage()}
                    disabled={!dashboard?.assistant?.configured || assistantState === 'loading'}
                  >
                    Send to copilot
                  </button>
                </div>

                {assistantError ? <div className="message-box error">{assistantError}</div> : null}
                {!dashboard?.assistant?.configured ? (
                  <div className="message-box neutral">
                    {assistantMeta.detail} Direct workspace and companion action buttons remain available.
                  </div>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="lt-app">
      <div className="lt-orb lt-orb-one" />
      <div className="lt-orb lt-orb-two" />
      <div className="lt-gridline" />

      <header className="hero-shell">
        <nav className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark">LT</div>
            <div>
              <p>LiquidTruffle</p>
              <span>HyperEVM operator suite with optional companion profiles</span>
            </div>
          </div>

          <div className="topbar-links">
            <div className={`topbar-key-pill tone-${workspaceKeyTone}`}>
              <span>Workspace signer</span>
              <KeyStatusLight configured={workspaceKeyConfigured} text={workspaceKeyText} />
              <em>{workspaceKeyDetail}</em>
            </div>
            <a href="#workspace">Studio</a>
            <a href="#commands">Build</a>
            <a href="#contracts">Contracts</a>
            <a href="#markets">Markets</a>
            {primaryCompanion?.running ? (
              <a
                className="topbar-link-accent"
                href={primaryCompanion.url}
                target="_blank"
                rel="noreferrer"
              >
                Open {companionLabel(primaryCompanion)}
              </a>
            ) : null}
          </div>
        </nav>

        <section className="hero-grid">
          <div className="hero-copy">
            <SectionEyebrow>Hyperliquid-style operator console</SectionEyebrow>
            <h1>Build, verify, and deploy HyperEVM contracts with live chain and venue context.</h1>
            <p className="hero-body">
              LiquidTruffle keeps the active workspace, compile and deploy jobs, contract registry,
              RPC status, and any configured companion app in one dark operator surface.
            </p>

            <div className="hero-metrics">
              <MetricPill label="Networks" value={String(dashboard?.networks?.length || 0)} tone="teal" />
              <MetricPill label="Workspaces" value={String(dashboard?.workspaces?.length || 0)} tone="orange" />
              <MetricPill label="Artifacts" value={String(workspaceStats.artifacts)} tone="coral" />
              <MetricPill label="Deploys" value={String(workspaceStats.deployments)} tone="olive" />
            </div>
          </div>

          <div className="hero-side">
            <article className="lt-panel launch-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Local Runtime</SectionEyebrow>
                  <h2>Start a workspace fast</h2>
                </div>
                <StatusBadge tone={dashboardState === 'ready' ? 'live' : dashboardState === 'error' ? 'error' : 'loading'}>
                  {dashboardState === 'ready' ? 'API ready' : dashboardState === 'error' ? 'API error' : 'Loading'}
                </StatusBadge>
              </div>

              <label className="field">
                <span>New workspace</span>
                <input
                  value={newWorkspaceName}
                  onChange={(event) => setNewWorkspaceName(event.target.value)}
                  placeholder="liquid-lab"
                />
              </label>

              <div className="hero-actions">
                <button className="lt-button lt-button-solid" onClick={createWorkspace}>
                  Create workspace
                </button>
                <a className="lt-button lt-button-ghost" href="#workspace">
                  Open workbench
                </a>
              </div>

              {dashboard?.health ? (
                <div className="runtime-facts">
                  <div>
                    <span>API</span>
                    <strong>127.0.0.1:{dashboard.health.port}</strong>
                  </div>
                  <div>
                    <span>{companionLabel(primaryCompanion)}</span>
                    <strong>{primaryCompanion?.running ? 'Live' : 'Offline'}</strong>
                  </div>
                  <div>
                    <span>Workspace</span>
                    <strong>{selectedWorkspace || 'None selected'}</strong>
                  </div>
                  <div>
                    <span>Network</span>
                    <strong>{NETWORK_OPTIONS.find((item) => item.key === networkChoice)?.label || networkChoice}</strong>
                  </div>
                  <div className="runtime-fact-wide">
                    <span>Workspace root</span>
                    <code>{dashboard.health.workspaceRoot}</code>
                  </div>
                </div>
              ) : null}

              {dashboardError ? <div className="message-box error">{dashboardError}</div> : null}
            </article>
          </div>
        </section>
      </header>

      <main className="content-shell">
        <section className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Network Surface</SectionEyebrow>
              <h2>Chain tape and Hyperliquid venue context.</h2>
            </div>
            <p>
              Keep RPC state and venue context in the same line of sight before you compile, deploy,
              or wire results back into the app.
            </p>
          </div>

          <div className="network-card-grid">
            {(dashboard?.networks || []).map((item) => (
              <NetworkCard key={item.key} item={item} />
            ))}
          </div>
        </section>

        <section className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>AI Launch</SectionEyebrow>
              <h2>Copilot, direct job controls, and optional companion profiles.</h2>
            </div>
            <p>
              The copilot stays pinned, stages edits before write, and can run direct operator jobs
              against the active workspace while exposing removable companion-specific shortcuts.
            </p>
          </div>

          <div className="assistant-grid">
            <article className="lt-panel assistant-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Copilot</SectionEyebrow>
                  <h3>Visible, workspace-aware AI helper</h3>
                </div>
                <div className="assistant-panel-top-badges">
                  <StatusBadge tone={assistantMeta.tone}>{assistantMeta.text}</StatusBadge>
                  <KeyStatusLight configured={workspaceKeyConfigured} text={workspaceKeyText} />
                </div>
              </div>

              <AssistantContextGrid
                workspaceName={selectedWorkspace}
                networkChoice={networkChoice}
                companionApp={primaryCompanion}
                deployment={latestDeployment}
              />

              <div className="message-box neutral assistant-summary-box">{assistantMeta.detail}</div>

              <div className="assistant-control-stack">
                <QuickActionStrip
                  title="Active workspace actions"
                  subtitle={
                    selectedWorkspace
                      ? `Run install, doctor, compile, test, or deploy directly for ${selectedWorkspace}.`
                      : 'Select a workspace to enable direct copilot job actions.'
                  }
                  actions={ACTIONS.map((action) => action.id)}
                  onRun={runWorkspaceShortcutAction}
                  busyKey={assistantActionKey}
                  disabled={!selectedWorkspace}
                  actionKeyPrefix="workspace-action"
                />

                {(dashboard?.companionProfiles || []).map((profile) => (
                  <CompanionProfileCard
                    key={profile.id}
                    profile={profile}
                    selectedWorkspace={selectedWorkspace}
                    networkChoice={networkChoice}
                    busyKey={assistantActionKey}
                    onSelectWorkspace={selectCompanionWorkspace}
                    onRunAction={runCompanionShortcutAction}
                    onRunTakeover={runCompanionTakeover}
                  />
                ))}
              </div>

              <div className="assistant-starters">
                {ASSISTANT_STARTERS.map((starter) => (
                  <button
                    key={starter}
                    className="starter-chip"
                    onClick={() => {
                      setAssistantDockOpen(true)
                      sendAssistantMessage(starter)
                    }}
                    disabled={!dashboard?.assistant?.configured || assistantState === 'loading'}
                  >
                    {starter}
                  </button>
                ))}
              </div>

              <div className="assistant-actions">
                <button
                  className="lt-button lt-button-solid"
                  onClick={openAssistantDocked}
                >
                  {assistantDockOpen ? 'Copilot open' : 'Open copilot'}
                </button>
                <button
                  className="lt-button lt-button-ghost"
                  onClick={openAssistantFullscreen}
                >
                  Take over screen
                </button>
                <button
                  className="lt-button lt-button-ghost"
                  onClick={() => {
                    setAssistantMessages([])
                    setAssistantSessionId('')
                    setAssistantError('')
                  }}
                >
                  Reset thread
                </button>
              </div>

              {assistantError ? <div className="message-box error">{assistantError}</div> : null}
              {!dashboard?.assistant?.configured ? (
                <div className="message-box neutral">
                  Chat-driven reasoning is unavailable until LiquidTruffle finds a local Codex login
                  or `OPENAI_API_KEY`. Direct job buttons above still work.
                </div>
              ) : null}
            </article>
          </div>
        </section>

        <section id="workspace" className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Workspace Control</SectionEyebrow>
              <h2>Workspace, env, and source tree.</h2>
            </div>
            <p>
              Move between projects, edit contracts and config, and keep all workspace state tied to
              the same operator surface.
            </p>
          </div>

          <div className="workspace-grid">
            <article className="lt-panel workspace-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Projects</SectionEyebrow>
                  <h3>Workspaces</h3>
                </div>
                <StatusBadge tone="neutral">{dashboard?.workspaces?.length || 0} active</StatusBadge>
              </div>

              <div className="workspace-list">
                {workspaceOptions.map((item) => (
                  <button
                    key={item.name}
                    className={`workspace-item ${selectedWorkspace === item.name ? 'active' : ''}`}
                    onClick={() => setSelectedWorkspace(item.name)}
                  >
                    <div>
                      <strong>{displayWorkspaceName(item.name)}</strong>
                      <span>{item.toolchain} toolchain</span>
                    </div>
                    <div className="workspace-mini">
                      <span>{item.artifactCount} artifacts</span>
                      <span>{item.deploymentCount} deploys</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="contract-creator">
                <label className="field">
                  <span>New contract</span>
                  <input
                    value={newContractName}
                    onChange={(event) =>
                      setNewContractName(event.target.value.replace(/[^A-Za-z0-9_]/g, '') || 'LaunchVault')
                    }
                    placeholder="LaunchVault"
                  />
                </label>
                <button className="lt-button lt-button-ghost" onClick={createContract}>
                  Add contract
                </button>
              </div>

              {workspaceError ? <div className="message-box error">{workspaceError}</div> : null}
            </article>

            <article className="lt-panel editor-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Editor</SectionEyebrow>
                  <h3>{selectedFile || 'Select a file'}</h3>
                </div>
                <div className="editor-topline">
                  {fileDirty ? <StatusBadge tone="loading">Unsaved</StatusBadge> : <StatusBadge tone="neutral">Saved</StatusBadge>}
                  <button className="lt-button lt-button-solid" onClick={saveFile} disabled={!selectedFile}>
                    Save file
                  </button>
                </div>
              </div>

              <div className="editor-layout">
                <div className="file-list">
                  {(workspace?.files || []).map((file) => (
                    <button
                      key={file}
                      className={`file-item ${file === selectedFile ? 'active' : ''}`}
                      onClick={() => setSelectedFile(file)}
                    >
                      {file}
                    </button>
                  ))}
                </div>

                <div className="editor-surface">
                  <textarea
                    value={fileContent}
                    onChange={(event) => {
                      setFileContent(event.target.value)
                      setFileDirty(true)
                    }}
                    spellCheck="false"
                    placeholder={fileState === 'loading' ? 'Loading file...' : 'Select a file from the workspace.'}
                  />
                  {fileNotice ? <div className="message-box neutral">{fileNotice}</div> : null}
                  {fileState === 'error' ? <div className="message-box error">Unable to load this file.</div> : null}
                </div>
              </div>
            </article>
          </div>
        </section>

        <section id="commands" className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Build Loop</SectionEyebrow>
              <h2>Job deck, preflight, and logs.</h2>
            </div>
            <p>
              Run backend-tracked jobs, inspect exact output, and verify signer readiness before you
              send anything on-chain.
            </p>
          </div>

          <div className="command-grid">
            <article className="lt-panel command-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Command Deck</SectionEyebrow>
                  <h3>Run the active workspace</h3>
                </div>
                <select value={networkChoice} onChange={(event) => setNetworkChoice(event.target.value)}>
                  {NETWORK_OPTIONS.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="action-grid">
                {ACTIONS.map((action) => (
                  <button
                    key={action.id}
                    className="action-card"
                    onClick={() => runAction(action.id)}
                    disabled={!selectedWorkspace || currentJobId !== ''}
                  >
                    <strong>{action.label}</strong>
                    <span>{action.summary}</span>
                  </button>
                ))}
              </div>

              <div className="job-output">
                <div className="job-meta">
                  <div>
                    <span>Latest job</span>
                    <strong>{latestJob ? latestJob.action : 'No jobs yet'}</strong>
                  </div>
                  {latestJob ? (
                    <StatusBadge
                      tone={
                        latestJob.status === 'completed'
                          ? 'live'
                          : latestJob.status === 'failed'
                            ? 'error'
                            : 'loading'
                      }
                    >
                      {latestJob.status}
                    </StatusBadge>
                  ) : null}
                </div>
                <pre>{latestJob ? latestJob.output || latestJob.command : 'Compile, test, or deploy output will appear here.'}</pre>
              </div>
            </article>

            <article className="lt-panel preflight-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Deploy Preflight</SectionEyebrow>
                  <h3>Signer and network sanity check</h3>
                </div>
                <StatusBadge tone={preflightState === 'ready' ? 'live' : preflightState === 'error' ? 'error' : 'loading'}>
                  {preflightState === 'ready' ? 'Ready' : preflightState === 'error' ? 'Error' : 'Loading'}
                </StatusBadge>
              </div>

              {preflight ? (
                <div className="preflight-grid">
                  <div>
                    <span>Network</span>
                    <strong>{preflight.network}</strong>
                  </div>
                  <div>
                    <span>RPC</span>
                    <code>{preflight.rpcUrl}</code>
                  </div>
                  <div>
                    <span>RPC mode</span>
                    <strong>{preflight.fallbackActive ? 'Fallback active' : 'Primary RPC'}</strong>
                  </div>
                  <div>
                    <span>Private key</span>
                    <strong>{preflight.privateKeyConfigured ? 'Configured' : 'Missing'}</strong>
                  </div>
                  <div>
                    <span>Deployer</span>
                    <strong>{preflight.deployer?.address || 'Not available'}</strong>
                  </div>
                  <div>
                    <span>Balance</span>
                    <strong>{preflight.deployer?.balance || '0.0000 HYPE'}</strong>
                  </div>
                  <div>
                    <span>Big blocks</span>
                    <strong>{preflight.deployer?.usingBigBlocks ? 'Enabled' : 'Not enabled'}</strong>
                  </div>
                  <div>
                    <span>Core gas</span>
                    <strong>{preflight.deployer?.gasPrice || 'N/A'}</strong>
                  </div>
                  <div>
                    <span>Big-block gas</span>
                    <strong>{preflight.deployer?.bigBlockGasPrice || 'N/A'}</strong>
                  </div>
                </div>
              ) : null}

              {preflightError ? <div className="message-box error">{preflightError}</div> : null}

              <div className="job-history">
                <h4>Recent jobs</h4>
                {(workspaceJobs || []).slice(0, 6).map((job) => (
                  <div key={job.id} className="job-row">
                    <div>
                      <strong>{job.action}</strong>
                      <span>{job.command}</span>
                    </div>
                    <StatusBadge
                      tone={
                        job.status === 'completed'
                          ? 'live'
                          : job.status === 'failed'
                            ? 'error'
                            : 'loading'
                      }
                    >
                      {job.status}
                    </StatusBadge>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section id="contracts" className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Contract Studio</SectionEyebrow>
              <h2>Artifacts, deploys, and live ABI calls.</h2>
            </div>
            <p>
              Use the compiled registry as the control point for reads, writes, and deployment
              inspection against HyperEVM.
            </p>
          </div>

          <div className="contracts-grid">
            <article className="lt-panel artifact-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Artifacts</SectionEyebrow>
                  <h3>Compiled contracts</h3>
                </div>
                <StatusBadge tone="neutral">{workspaceStats.artifacts} total</StatusBadge>
              </div>

              <div className="artifact-list">
                {(workspace?.artifacts || []).map((artifact) => (
                  <button
                    key={artifact.relativePath}
                    className={`artifact-item ${invokeArtifactPath === artifact.relativePath ? 'active' : ''}`}
                    onClick={() => setInvokeArtifactPath(artifact.relativePath)}
                  >
                    <div>
                      <strong>{artifact.contractName}</strong>
                      <span>{artifact.sourceName}</span>
                    </div>
                    <div className="artifact-meta">
                      <span>{artifact.readFunctions.length} reads</span>
                      <span>{artifact.writeFunctions.length} writes</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="deployment-list">
                <h4>Deployments</h4>
                {(workspace?.deployments || []).map((entry) =>
                  (entry.deployments || []).map((deployment) => (
                    <div key={`${entry.network}-${deployment.txHash || deployment.address}`} className="deployment-item">
                      <div>
                        <strong>{deployment.contractName}</strong>
                        <span>{entry.network}</span>
                      </div>
                      <code>{deployment.address}</code>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className="lt-panel invoke-panel">
              <div className="panel-topline">
                <div>
                  <SectionEyebrow>Invoke</SectionEyebrow>
                  <h3>Read or write with the active artifact ABI</h3>
                </div>
                <StatusBadge tone={invokeState === 'ready' ? 'live' : invokeState === 'error' ? 'error' : 'neutral'}>
                  {invokeState === 'ready' ? 'Complete' : invokeState === 'error' ? 'Failed' : 'Idle'}
                </StatusBadge>
              </div>

              <div className="form-grid">
                <label className="field">
                  <span>Artifact</span>
                  <select value={invokeArtifactPath} onChange={(event) => setInvokeArtifactPath(event.target.value)}>
                    {(workspace?.artifacts || []).map((artifact) => (
                      <option key={artifact.relativePath} value={artifact.relativePath}>
                        {artifact.contractName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Mode</span>
                  <select value={invokeMode} onChange={(event) => setInvokeMode(event.target.value)}>
                    <option value="read">Read</option>
                    <option value="write">Write</option>
                  </select>
                </label>

                <label className="field">
                  <span>Address</span>
                  <input
                    value={invokeAddress}
                    onChange={(event) => setInvokeAddress(event.target.value)}
                    placeholder="0x..."
                  />
                </label>

                <label className="field">
                  <span>Function</span>
                  <select value={invokeFunctionName} onChange={(event) => setInvokeFunctionName(event.target.value)}>
                    {availableFunctions.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Arguments as JSON array</span>
                <textarea
                  className="arg-textarea"
                  value={invokeArgs}
                  onChange={(event) => setInvokeArgs(event.target.value)}
                  spellCheck="false"
                />
              </label>

              <div className="invoke-actions">
                <button className="lt-button lt-button-solid" onClick={runInvoke}>
                  Run function
                </button>
                <span>
                  Writes use `PRIVATE_KEY` from the active workspace `.env`. Reads use public RPC only.
                </span>
              </div>

              {invokeError ? <div className="message-box error">{invokeError}</div> : null}
              <pre className="invoke-output">{invokeResult || 'Function results will appear here.'}</pre>
            </article>
          </div>
        </section>

        <section className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Probe</SectionEyebrow>
              <h2>Address probe.</h2>
            </div>
            <p>
              Quick-read any address for balance, nonce, bytecode, and big-block status.
            </p>
          </div>

          <div className="probe-shell">
            <article className="lt-panel probe-panel">
              <div className="form-grid">
                <label className="field">
                  <span>Network</span>
                  <select value={probeNetwork} onChange={(event) => setProbeNetwork(event.target.value)}>
                    {NETWORK_OPTIONS.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Address</span>
                  <input
                    value={probeAddress}
                    onChange={(event) => setProbeAddress(event.target.value)}
                    placeholder="0x..."
                  />
                </label>

                <button className="lt-button lt-button-solid" onClick={runProbe}>
                  Probe address
                </button>
              </div>

              {probeResult ? (
                <div className="probe-grid">
                  <div>
                    <span>Balance</span>
                    <strong>{probeResult.balance}</strong>
                  </div>
                  <div>
                    <span>Nonce</span>
                    <strong>{probeResult.nonce}</strong>
                  </div>
                  <div>
                    <span>Bytecode</span>
                    <strong>{probeResult.codeSize}</strong>
                  </div>
                  <div>
                    <span>Type</span>
                    <strong>{probeResult.isContract ? 'Contract' : 'EOA'}</strong>
                  </div>
                  <div>
                    <span>Big blocks</span>
                    <strong>{probeResult.usingBigBlocks ? 'Enabled' : 'Not enabled'}</strong>
                  </div>
                </div>
              ) : null}

              {probeState === 'loading' ? <div className="message-box neutral">Querying HyperEVM...</div> : null}
              {probeError ? <div className="message-box error">{probeError}</div> : null}
            </article>
          </div>
        </section>

        <section id="markets" className="section-block">
          <div className="section-head">
            <div>
              <SectionEyebrow>Hyperliquid Surface</SectionEyebrow>
              <h2>Tokens, spot, and perp context.</h2>
            </div>
            <p>
              This keeps the contract workflow grounded in the actual Hyperliquid venue instead of a
              generic EVM dashboard.
            </p>
          </div>

          <div className="market-grid">
            <MarketTable
              eyebrow="Tokens"
              title="EVM-mapped spot tokens"
              columns={[
                { key: 'name', label: 'Token', render: (row) => row.name },
                { key: 'address', label: 'EVM address', render: (row) => <code>{row.address}</code> },
                { key: 'canon', label: 'Canonical', render: (row) => (row.isCanonical ? 'Yes' : 'No') },
              ]}
              rows={(dashboard?.hyperliquid?.tokens || []).map((row) => ({ ...row, id: row.address }))}
            />

            <MarketTable
              eyebrow="Spot"
              title="Top spot pairs by notional volume"
              columns={[
                { key: 'name', label: 'Pair', render: (row) => row.name },
                { key: 'mark', label: 'Mark', render: (row) => row.markPx },
                { key: 'volume', label: '24h volume', render: (row) => formatVolume(row.dayNtlVlm) },
              ]}
              rows={(dashboard?.hyperliquid?.spotMarkets || []).map((row) => ({ ...row, id: row.name }))}
            />

            <MarketTable
              eyebrow="Perps"
              title="Top perps by notional volume"
              columns={[
                { key: 'name', label: 'Market', render: (row) => row.name },
                { key: 'mark', label: 'Mark', render: (row) => row.markPx },
                { key: 'funding', label: 'Funding', render: (row) => row.funding },
                { key: 'volume', label: '24h volume', render: (row) => formatVolume(row.dayNtlVlm) },
              ]}
              rows={(dashboard?.hyperliquid?.perps || []).map((row) => ({ ...row, id: row.name }))}
            />
          </div>
        </section>
      </main>

      <div
        className={`assistant-dock ${assistantDockOpen ? 'open' : 'closed'} ${
          assistantDockMode === 'fullscreen' ? 'fullscreen' : 'docked'
        }`}
      >
        <div className="assistant-dock-launchers">
          <button
            className="assistant-dock-toggle"
            onClick={toggleAssistantDock}
          >
            <span>Copilot</span>
            <strong>{assistantDockOpen ? 'Hide' : 'Open'}</strong>
          </button>
          <button
            className="assistant-dock-toggle assistant-dock-toggle-secondary"
            onClick={() =>
              assistantDockMode === 'fullscreen' ? openAssistantDocked() : openAssistantFullscreen()
            }
          >
            <span>{assistantDockMode === 'fullscreen' ? 'Exit takeover' : 'Take over'}</span>
            <strong>{assistantDockMode === 'fullscreen' ? 'Dock view' : 'Full screen'}</strong>
          </button>
        </div>

        {assistantDockOpen ? (
          <aside className="lt-panel assistant-dock-panel">
            <div className="panel-topline">
              <div>
                <SectionEyebrow>Copilot</SectionEyebrow>
                <h3>LiquidTruffle chat</h3>
              </div>
              <div className="assistant-panel-controls">
                <StatusBadge tone={assistantMeta.tone}>{assistantMeta.text}</StatusBadge>
                <KeyStatusLight configured={workspaceKeyConfigured} text={workspaceKeyText} />
                <button
                  className="lt-button lt-button-ghost assistant-panel-control-button"
                  onClick={() =>
                    assistantDockMode === 'fullscreen' ? openAssistantDocked() : openAssistantFullscreen()
                  }
                >
                  {assistantDockMode === 'fullscreen' ? 'Docked' : 'Full screen'}
                </button>
                <button
                  className="lt-button lt-button-ghost assistant-panel-control-button"
                  onClick={() => {
                    setAssistantDockOpen(false)
                    setAssistantDockMode('dock')
                  }}
                >
                  Hide
                </button>
              </div>
            </div>

            <div className="assistant-functional-controls">
              <AssistantContextGrid
                workspaceName={selectedWorkspace}
                networkChoice={networkChoice}
                companionApp={primaryCompanion}
                deployment={latestDeployment}
              />

              {primaryTakeoverProfile ? (
                <div className="assistant-takeover-strip">
                  <div className="assistant-takeover-copy">
                    <strong>One-button contract flow</strong>
                    <p>
                      1) install + doctor, 2) compile + test, 3) deploy. Copilot runs this sequence
                      against the {primaryTakeoverProfile.label} workspace and halts on first failure.
                    </p>
                  </div>
                  <button
                    className="lt-button lt-button-solid"
                    onClick={() => runCompanionTakeover(primaryTakeoverProfile)}
                    disabled={
                      !primaryTakeoverProfile.workspaceExists ||
                      assistantActionKey === `companion-flow:${primaryTakeoverProfile.id}`
                    }
                  >
                    {assistantActionKey === `companion-flow:${primaryTakeoverProfile.id}`
                      ? `${primaryTakeoverProfile.label} flow running...`
                      : `Run ${primaryTakeoverProfile.label} one-button flow`}
                  </button>
                </div>
              ) : null}

              <div className="assistant-control-stack assistant-control-stack-dock">
                <QuickActionStrip
                  title="Active workspace actions"
                  subtitle={
                    selectedWorkspace
                      ? `Direct job controls for ${selectedWorkspace}.`
                      : 'Select a workspace to enable direct job controls.'
                  }
                  actions={ACTIONS.map((action) => action.id)}
                  onRun={runWorkspaceShortcutAction}
                  busyKey={assistantActionKey}
                  disabled={!selectedWorkspace}
                  actionKeyPrefix="workspace-action"
                />

                {(dashboard?.companionProfiles || []).map((profile) => (
                  <CompanionProfileCard
                    key={profile.id}
                    profile={profile}
                    selectedWorkspace={selectedWorkspace}
                    networkChoice={networkChoice}
                    busyKey={assistantActionKey}
                    onSelectWorkspace={selectCompanionWorkspace}
                    onRunAction={runCompanionShortcutAction}
                    onRunTakeover={runCompanionTakeover}
                  />
                ))}
              </div>
            </div>

            <div className="assistant-chat-shell">
              <div className="assistant-thread">
                {assistantMessages.length ? (
                  assistantMessages.map((message, index) => (
                    <article
                      key={`${message.role}-${index}`}
                      className={`assistant-message ${message.role === 'assistant' ? 'assistant' : 'user'}`}
                      >
                        <header>
                          <strong>{message.role === 'assistant' ? 'LiquidTruffle Copilot' : 'You'}</strong>
                        </header>
                        <p>{message.text}</p>
                        {message.companionFindings?.length ? (
                          <div className="assistant-findings">
                            {message.companionFindings.map((finding, findingIndex) => (
                              <div key={`${finding.title}-${findingIndex}`} className="assistant-finding">
                                <strong>{finding.title}</strong>
                                <span>{finding.detail}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {message.usedTools?.length ? (
                          <div className="assistant-tools">
                            {message.usedTools.map((tool, toolIndex) => (
                              <span key={`${assistantToolLabel(tool)}-${toolIndex}`}>
                                {assistantToolLabel(tool)}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {message.proposals?.length ? (
                          <div className="assistant-artifact-stack">
                            {message.proposals.map((proposal) => (
                              <AssistantProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                onApply={applyAssistantProposal}
                                onDiscard={discardAssistantProposal}
                                busy={assistantActionKey === `proposal:${proposal.id}`}
                                companionApp={primaryCompanion}
                              />
                            ))}
                          </div>
                        ) : null}
                        {message.jobs?.length ? (
                          <div className="assistant-artifact-stack">
                            {message.jobs.map((job) => (
                              <AssistantJobCard
                                key={job.id}
                                job={job}
                                onRun={runAssistantJob}
                                busy={assistantActionKey === `job:${job.id}`}
                                showOutput={false}
                              />
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))
                ) : (
                  <div className="assistant-empty">
                    Use the direct buttons above to run install, doctor, compile, test, or deploy for
                    the active workspace or an optional companion profile. Use chat when you want
                    analysis, diffs, or repo-aware guidance.
                  </div>
                )}
              </div>

              <label className="field assistant-composer-field">
                <span>Ask the copilot</span>
                <textarea
                  className="assistant-input"
                  value={assistantInput}
                  onChange={(event) => setAssistantInput(event.target.value)}
                  placeholder="Inspect the current workspace, compile it, and tell me exactly what happened."
                  spellCheck="false"
                />
              </label>

              <div className="assistant-actions">
                <button
                  className="lt-button lt-button-solid"
                  onClick={() => sendAssistantMessage()}
                  disabled={!dashboard?.assistant?.configured || assistantState === 'loading'}
                >
                  Send to copilot
                </button>
                <button
                  className="lt-button lt-button-ghost"
                  onClick={() => {
                    setAssistantMessages([])
                    setAssistantSessionId('')
                    setAssistantError('')
                  }}
                >
                  Reset thread
                </button>
              </div>

              {assistantError ? <div className="message-box error">{assistantError}</div> : null}
              {!dashboard?.assistant?.configured ? (
                <div className="message-box neutral">
                  {assistantMeta.detail} Direct workspace and companion action buttons remain available.
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

export default App

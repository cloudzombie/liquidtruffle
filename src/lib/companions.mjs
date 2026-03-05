const COMPANION_ACTIONS = ['install', 'doctor', 'compile', 'test', 'deploy']

export const COMPANION_PROFILES = [
  {
    id: 'companion',
    label: 'Companion',
    workspaceName: '',
    appUrl: process.env.LIQUIDTRUFFLE_COMPANION_APP_URL || 'http://127.0.0.1:5173',
    files: [],
    actions: COMPANION_ACTIONS,
    autopilotActions: COMPANION_ACTIONS,
    runbook: [
      {
        title: 'Compile and test before deploy',
        detail: 'Install dependencies, run doctor, then compile and test before any live deployment.',
      },
      {
        title: 'Deploy with explicit network selection',
        detail: 'Use deploy against the selected network and verify addresses before wiring app config.',
      },
    ],
    description:
      'Optional companion profile for an adjacent application that consumes deployment outputs.',
    removeHint: 'Remove this profile entry if you do not need companion app integration.',
    defaultWorkspace: false,
  },
]

export function listCompanionProfiles() {
  return COMPANION_PROFILES
}

export function getCompanionProfile(profileId) {
  return COMPANION_PROFILES.find((profile) => profile.id === profileId) || null
}

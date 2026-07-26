/**
 * User-facing auth copy for the web app (docs/auth-ux-overhaul-plan.md Phase 0).
 * One file so the wording stays consistent across /signin, /pair, /reset-keys,
 * onboarding and the devices list — and so `__tests__/copy.test.ts` can assert
 * the no-jargon rules over every string at once.
 */

export const copy = {
  signin: {
    titleDefault: "Sign in to Falcon",
    titleWithPendingPair: "Connect your machine",
    subtitleWithPendingPair: (machine: string) => `Sign in to finish connecting ${machine}.`,
    expiredBanner: "Your session expired — sign in to continue.",
  },

  pair: {
    approveTitle: "Connect this machine?",
    approveWarning: "Only approve this if you just ran `falcon` yourself.",
    approveCta: "Approve",
    /** Shown on the Approve button in place of `approveCta` while the crypto worker is
     *  still booting — the button must never look clickable before `approve()` can do
     *  anything (auth-ux-overhaul-fix-plan.md Fix 11). */
    preparingCta: "Preparing…",
    cancelCta: "Cancel",
    approvingLabel: "Connecting…",
    doneTitle: "Connected",
    doneBody: (machine: string) =>
      `${machine} is connected. Go back to your terminal — your session is starting.`,
    doneCta: "Go to dashboard",
    invalidLink: "This link is out of date. Run `falcon` again on your machine to get a fresh one.",
    signedOutMidFlow: "You've been signed out. Sign in again to finish connecting.",
    checking: "Checking link…",
    retryCta: "Try again",
    unknownMachine: "Unknown machine",
    /** Shown on the key-request panel when it interrupts a pairing, so the two prompts read
     *  as one flow instead of two unrelated demands. */
    resumeAfterKeys: (machine: string) =>
      `Once your keys arrive, we'll bring you straight back to connecting ${machine}.`,
  },

  keys: {
    needKeysTitle: "One more step",
    needKeysBody:
      "Your sessions are end-to-end encrypted, so this browser needs a copy of your keys. " +
      "We'll ask a device you're already signed in on — you approve it there, and this page " +
      "continues on its own.",
    /** Shown while the request is being raised, so the first thing on screen isn't a blank. */
    needKeysStarting: "Asking your other devices…",
    codeIntroRequester: "Check that your other device shows this same code:",
    codeIntroApprover: "Make sure the device asking shows this same code:",
    /** The requester half of the mismatch warning. `codeMismatch` below is the approver's;
     *  the check is only a control if BOTH ends know what a mismatch means. */
    codeMismatchRequester:
      "If the codes don't match, don't approve it — someone else may be asking.",
    codeMismatch: "Codes don't match? Cancel — someone else may be asking.",
    waitingBody: "This page continues automatically once they arrive.",
    sendCta: "Codes match — send my keys",
    denyCta: "Not now",
    approveTitle: "Send your keys to another device?",
    approveBody: "A device is asking for a copy of your keys so it can read your sessions.",
    cantReach: "Can't reach any of those devices?",
    noOtherDevices: "No other devices are signed in.",
    /** The "run `falcon keys approve`" instruction — pulled out of the component's inline
     *  JSX so `copy.test.ts`'s jargon walker can see it (it previously couldn't, being the
     *  one user-facing string in `request-keys-panel.tsx` not routed through `copy.*`). */
    noOtherDevicesHint: (command: string) => `Run ${command} on a machine that has your keys.`,
    signedOut: "You've been signed out. Sign in again.",
    unreadable: "Those keys couldn't be read. Ask the other device to try again.",
    timedOut: "The request timed out. Reload this page to try again.",
    abuseTitle: "Too many key requests",
    abuseBody:
      "Something is repeatedly asking for your keys. Don't approve anything — open Settings → Devices and sign out anything you don't recognise.",
    sendingLabel: "Sending…",
    waitingLabel: "Waiting…",
  },

  reset: {
    linkLabel: "Start over with new keys",
    warning: "This permanently erases all past sessions and signs out every other device.",
    confirmCta: "Yes, erase my past sessions",
    cancelCta: "Cancel",
  },

  onboarding: {
    title: "Connect your first machine",
    subtitle: "Falcon runs on your own computer. Two commands.",
    step1: "Install",
    step1Cmd: "npm install -g falcon",
    step2: "Run it from any project",
    step2Cmd: "cd ~/your-project && falcon",
    step3: "Approve when your browser asks",
    step3Hint: "We'll bring you back here automatically.",
    waiting: "Waiting for your first machine…",
  },

  devices: {
    explainer:
      "Anyone using one of these devices can read your sessions. Sign out anything you don't recognise.",
  },

  session: {
    /** Shown when a session refresh couldn't reach the server at all — distinct from a
     *  genuine sign-out, which redirects instead. See `RequireAuth`'s `unreachable` state. */
    cantReachServer: "Can't reach Falcon right now. We'll keep trying.",
    retryCta: "Try again",
  },
} as const;

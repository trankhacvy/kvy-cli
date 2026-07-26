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
    /** Plain-language value line under the title — mirrors the landing hero's verbs,
     *  no design-doc words ("trusted devices", "access recovery"). */
    subtitleDefault:
      "Approve, steer, and review your coding agents from any browser — end-to-end encrypted.",
    /** Pair-pending visits get the pair title AND this subtitle in place of a separate
     *  banner box — one message, not two competing ones. */
    subtitleWithPendingPair:
      "Sign in to finish connecting your machine — we'll bring you right back.",
    expiredBanner: "Your session expired — sign in to continue.",
    /** Both OAuth providers unconfigured (self-host/dev): the buttons are hidden, this
     *  is the only mention — an admin-facing setup note, not an end-user error. */
    oauthUnavailable:
      "Google and GitHub sign-in aren't set up on this server yet — use email to continue.",
    emailCta: "Continue with email",
    /** Honesty rule (auth-ux-overhaul-plan.md principle 7): the password routes 404 in
     *  production (`requireNonProduction`), so the button says where it works. */
    emailHint: "Email sign-in is only available on local setups.",
    /** The sign-up affordance: nothing else on the page tells a newcomer that signing
     *  in also registers them. */
    footer: "New to Falcon? Signing in also creates your account.",
    /** Caption over the art panel — the landing hero's tagline, so the two public
     *  pages speak with one voice. */
    panelCaption: "Walk away. Your agents won't.",
  },

  pair: {
    approveTitle: "Connect this machine?",
    /** Sits under `approveTitle` so the confirm screen reads as one sentence about what's
     *  about to happen, not a bare heading over a data table. */
    confirmSubtitle:
      "Someone requested access using the Falcon CLI — review the details below before approving.",
    approveWarning: "Only approve this if you just ran `falcon` yourself.",
    approveCta: "Approve",
    /** Shown on the Approve button in place of `approveCta` while the crypto worker is
     *  still booting — the button must never look clickable before `approve()` can do
     *  anything (auth-ux-overhaul-fix-plan.md Fix 11). */
    preparingCta: "Preparing…",
    cancelCta: "Cancel",
    /** Takes the resolved machine name (falls back to `unknownMachine`) so the transient
     *  screen names what it's doing instead of a bare "Connecting…". */
    approvingLabel: (machine: string) => `Connecting ${machine}…`,
    doneTitle: "Connected",
    doneBody: (machine: string) =>
      `${machine} is connected. Go back to your terminal — your session is starting.`,
    doneCta: "Go to dashboard",
    invalidLinkTitle: "This link is out of date",
    invalidLinkBody:
      "Run `falcon` again on your machine to get a fresh link — pairing links expire quickly for security.",
    /** Heading for the `error` gate — the message itself (`gate.message`, e.g. "Request not
     *  found") is dynamic and rendered as the body underneath, not the whole screen. */
    errorTitle: "Approval failed",
    signedOutMidFlow: "You've been signed out. Sign in again to finish connecting.",
    checking: "Checking your link…",
    retryCta: "Try again",
    backCta: "Back to Falcon",
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
    pageTitle: "Recover this browser",
    pageSubtitle:
      "The safest option keeps all your encrypted sessions. Resetting keys signs out every " +
      "other device and locks away everything encrypted under your old keys.",
    fetchKeysCta: "Get my keys from another device",
    resetInsteadCta: "Reset keys instead",
    confirmHeading: "Confirm it's you",
    confirmBody:
      "This permanently archives everything encrypted under your current keys and signs out every other device.",
    /** Shown in the destructive confirm box only when neither OAuth provider is configured —
     *  the password option is always offered alongside it, so this box is never a dead end
     *  the way it used to be when both providers were unconfigured and disabled. */
    oauthUnavailable: "Google and GitHub aren't set up on this server — use your password instead.",
    passwordCta: "Confirm with password",
    passwordSubmitCta: "Confirm",
    passwordError: "That password is incorrect.",
    /** Honesty rule (same as copy.signin.emailHint): the password routes 404 in production. */
    passwordHint: "Only available on local setups.",
    rotating: "Rotating your keys…",
    rotatingErrorTitle: "Couldn't rotate your keys",
    retryCta: "Try again",
    signedOutMidFlow: "You've been signed out. Please start over.",
    signedOutTitle: "You've been signed out",
    backToSigninCta: "Back to sign in",
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

  oauthCallback: {
    working: "Finishing sign-in…",
    errorTitle: "Sign-in didn't go through",
    backToSigninCta: "Back to sign in",
  },

  session: {
    /** Shown when a session refresh couldn't reach the server at all — distinct from a
     *  genuine sign-out, which redirects instead. See `RequireAuth`'s `unreachable` state. */
    cantReachServer: "Can't reach Falcon right now. We'll keep trying.",
    retryCta: "Try again",
  },
} as const;

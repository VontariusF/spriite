/**
 * Setup flow copy, verbatim from the boards (Main, Pair, Paired, Repo, Ready,
 * Move). Lines no board draws (failure messages, undrawn states) are marked
 * and recorded in docs/design/deviations/setup.md.
 *
 * No runtime imports and erasable-only syntax.
 */
import type { PairFailure, TransferFailure } from '../../pair/types'

export const COPY = {
  welcome: {
    brand: 'Spriite',
    title: 'Let’s get your glasses building.',
    lead: 'Choose how Spriite reaches Factory. Everything else can wait.',
    pairTitle: 'Pair with my Factory computer',
    pairBadge: 'Best',
    pairDesc: 'Run one command where Factory runs. Your keys, repos and host link come over together.',
    keyTitle: 'Use my Factory key only',
    keyDesc: 'Paste one API key. Builds run in Factory’s cloud.',
    moveTitle: 'Move from another phone',
    moveDesc: 'Bring every key and build over with a transfer code.',
    lock: 'Secrets are encrypted end to end. The relay never sees them.',
  },
  pair: {
    title: 'Run this on your Factory computer',
    lead: 'Open a terminal where Factory is signed in. It finds your keys and repos, starts the Spriite host, and shows a code.',
    command: 'npx spriite pair',
    copy: 'Copy',
    copied: 'Copied', // undrawn
    noNode: 'No Node?',
    installer: 'Get the installer for macOS, Linux or Windows',
    installerUrl: 'https://nodejs.org/en/download',
    codeLabel: 'Type the code it shows',
    scan: 'Scan the QR code instead',
    scanStop: 'Stop scanning', // undrawn
    scanUnavailable: 'Scanning isn’t available on this phone. Type the code instead.', // undrawn
    scanFailed: 'The camera didn’t open. Type the code instead.', // undrawn
    scanNotPair: 'That QR code isn’t a Spriite pairing code.', // undrawn
    listening: 'Listening for your computer…',
    listeningSub: 'The code works for 10 minutes and only once.',
    connect: 'Connect',
    connecting: 'Connecting…', // undrawn
    keyOnly: 'I only have a Factory key',
    incomplete: 'Type all six characters of the code.', // undrawn
  },
  paired: {
    title: (label: string) => `Paired with “${label}”`,
    sub: 'Here is what came over. Nothing to type.',
    found: 'Found',
    later: 'Later',
    runTitle: 'Where should builds run?',
    runGroup: 'Where builds run',
    runHost: (label: string) => `On “${label}”`,
    runHostSub: 'Your machine, your tools',
    /** Undrawn: no Droid computer came over, so builds cannot run there yet. */
    runHostNone: 'No Droid computer found',
    runCloud: 'Factory cloud',
    runCloudSub: (label: string) => `Runs while ${label} is off`,
    confirm: 'Looks right',
    saving: 'Saving…', // undrawn
    footnote: 'Keys are stored encrypted on this phone. Change any of them in Settings.',
    saveFailed: 'Some keys didn’t save. Try again, or change them later in Settings.', // undrawn
  },
  rows: {
    factory: 'Factory account',
    factoryOk: (label: string) => `Signed in on ${label}`,
    factoryMissing: 'No Factory login found',
    computer: 'Droid computer',
    computerOk: (name: string, online: boolean) => `${name} · ${online ? 'online' : 'offline'}`,
    computerMissing: 'No Droid computer found',
    host: 'Spriite host',
    hostTailscale: 'Private link over Tailscale',
    hostHttps: 'Private link over HTTPS',
    hostMissing: 'No host link found',
    github: 'GitHub',
    githubOk: (count: number | null) =>
      count === null ? 'From the GitHub CLI' : `From the GitHub CLI · ${count} ${count === 1 ? 'repo' : 'repos'}`,
    githubMissing: 'No GitHub CLI login found',
    voice: 'Voice replies',
    voiceOk: 'ElevenLabs key from your computer',
    voiceMissing: 'No ElevenLabs key found',
    x: 'X requests',
    xOk: 'X app and token from your computer',
    xLater: 'Connect from your computer later',
  },
  repo: {
    keyLabel: 'Factory API key',
    keyPlaceholder: 'fk-…',
    paste: 'Paste',
    keyLink: 'Get a key at app.factory.ai › Settings › API keys',
    keyUrl: 'https://app.factory.ai/settings/api-keys',
    title: 'Where should builds go?',
    lead: 'You can change this per build, by voice or on the phone.',
    group: 'Repository choice',
    perIdea: 'A new private repo for each idea',
    perIdeaDesc: 'Spriite names it from what you say. Nothing lands in an existing repo by accident.',
    one: 'One repo I choose',
    oneDesc: 'Pick from the list or paste any GitHub link.',
    searchLabel: 'Or start from a repo',
    searchPlaceholder: 'Search, or paste github.com/…',
    finish: 'Finish setup',
    finishing: 'Checking…', // undrawn
    loading: 'Loading your repos…', // undrawn
    loadFailed: 'Couldn’t load your repos. Paste a GitHub link instead.', // undrawn
    noMatch: 'No repo matches. Paste a GitHub link to use any repo.', // undrawn
    pastedMeta: 'GitHub link', // undrawn
    savedMeta: 'Current choice', // undrawn
    keyRejected: 'Factory didn’t accept that key. Check it and try again.', // undrawn
    saveFailed: 'Couldn’t save on this phone. Try again.', // undrawn
    pickRepo: 'Pick a repo from the list or paste a GitHub link.', // undrawn
  },
  ready: {
    title: 'Spriite is ready.',
    lead: 'On the glasses, hold the touchpad and say what to build. Or type it here.',
    extras: 'Optional extras',
    voice: 'Spoken replies',
    voiceDesc: 'Spriite reads updates aloud with ElevenLabs.',
    x: 'Build from X posts',
    xDesc: (label: string | null) => `Tag your Spriite account. Sign-in opens on ${label ?? 'your computer'}.`,
    cursor: 'Cursor workers',
    cursorDesc: 'Hand big tasks to Cursor agents too.',
    addKey: 'Add key',
    connect: 'Connect',
    added: 'Added', // undrawn
    checkKey: 'Check key', // undrawn: a saved key the service rejected
    connected: 'Connected', // undrawn
    open: 'Open Spriite',
  },
  move: {
    back: 'Back to settings',
    title: 'Move Spriite to another phone',
    lead: 'On the new phone, open Spriite and choose “Move from another phone”.',
    qr: 'QR code for the transfer',
    or: 'or type this code',
    expires: (left: string) => `Works once · expires in ${left}`,
    making: 'Making a code…', // undrawn
    expired: 'This code expired.', // undrawn
    moved: 'Moved. The new phone has everything.', // undrawn
    newCode: 'Make a new code', // undrawn
    whatMoves: 'What moves',
    moveKeys: (label: string | null) => `Every key and the link to ${label ?? 'your computer'}`,
    moveDefaults: 'Build defaults and repo choices',
    moveHistory: 'Build history and chats',
    lock: 'Everything is encrypted with this code before it leaves the phone.',
  },
  receive: { // undrawn screen composed from Pair
    title: 'Move from another phone',
    lead: 'On the old phone, open Settings › Move to another phone. It shows a code.',
    codeLabel: 'Type the code it shows',
    listening: 'Listening for your other phone…',
    listeningSub: 'The code works for 10 minutes and only once.',
    connect: 'Connect',
    incomplete: 'Type all three parts of the code.',
    scanNotMove: 'That QR code isn’t a Spriite transfer code.',
    applyFailed: 'Nothing could be saved on this phone. Try again.',
  },
} as const

/** Short, honest messages for each pairing failure (undrawn state). */
export const PAIR_FAILURE: Record<PairFailure, string> = {
  not_found: 'No computer is waiting with that code. Check it and try again.',
  expired: 'That code expired. Run npx spriite pair again for a new one.',
  used: 'That code was already used. Run npx spriite pair again for a new one.',
  wrong_code: 'That code doesn’t match. Check the characters and try again.',
  unreachable: 'Couldn’t reach the pairing relay. Check your connection and try again.',
  cancelled: 'Pairing was cancelled.',
  invalid: 'What came over isn’t a valid pairing. Run npx spriite pair again.',
}

/** The same for moving between phones (undrawn state). */
export const TRANSFER_FAILURE: Record<TransferFailure, string> = {
  not_found: 'No phone is waiting with that code. Check it and try again.',
  expired: 'That code expired. Make a new one on the other phone.',
  used: 'That code was already used. Make a new one on the other phone.',
  wrong_code: 'That code doesn’t match. Check it and try again.',
  unreachable: 'Couldn’t reach the relay. Check your connection and try again.',
  cancelled: 'The move was cancelled.',
  invalid: 'What came over isn’t a valid transfer. Make a new code and try again.',
  too_large: 'There is too much to move in one code.',
}

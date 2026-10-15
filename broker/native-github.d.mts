import type { Runner } from './native-delivery.mjs'

export declare const GITHUB_CALL_TIMEOUT_MS: number
export declare const GITHUB_CALL_MAX_BYTES: number
export declare const GITHUB_CALL_RUNNER_MAX_BYTES: number
export declare const GITHUB_CALL_MAX_CONCURRENT: number
export declare const GITHUB_CAPABILITY_TTL_MS: number
export declare const GITHUB_CAPABILITY_MISS_TTL_MS: number
export declare const GITHUB_PROBE_TIMEOUT_MS: number
export declare const GITHUB_CAPABILITY_WAIT_MS: number
export declare const GITHUB_REPO_DESCRIPTION_MAX: number

/** GET /v1/native/capabilities `github`; the token never appears here. */
export interface GitHubCapability { available: boolean; login: string | null }
export declare const GITHUB_UNAVAILABLE: Readonly<GitHubCapability>

/** POST /v1/native/github/call body. */
export interface GitHubCallInput {
  method: 'GET' | 'POST'
  path: string
  body?: { name: string; description: string; private: true; auto_init: true }
}
/** GitHub's own status and parsed JSON (null when the body was empty or not JSON). */
export interface GitHubCallResult { status: number; body: unknown }

export interface GitHubGetRule {
  readonly name: string
  readonly pattern: RegExp
  readonly segments: ReadonlyArray<(segment: string) => boolean>
  readonly query?: Readonly<Record<string, (value: string) => boolean>>
}
export declare const GITHUB_GET_ALLOWLIST: ReadonlyArray<GitHubGetRule>

/** The exact call gh may make; throws BrokerError github_call_refused (403) otherwise. */
export declare function allowedGitHubCall(input: unknown): Readonly<GitHubCallInput>
export declare function parseIncluded(stdout: unknown): GitHubCallResult | null

export interface NativeGitHub {
  capability(): Promise<GitHubCapability>
  call(input: unknown): Promise<GitHubCallResult>
}
export declare function createNativeGitHub(options: {
  gh: Runner
  now?: () => number
  ttlMs?: number
  missTtlMs?: number
  maxConcurrent?: number
}): NativeGitHub

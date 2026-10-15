import type { XPost } from '../src/intake/x-transport.js'
import type { ContextArtifact, XOwnerBinding } from '../src/domain/types.js'

export type XRulesBinding = Pick<XOwnerBinding, 'ownerXUserId' | 'spriiteXUserId'>
export type TriggerVerdict =
  | { ok: true; instruction: string }
  | { ok: false; reason: 'not_owner' | 'not_a_trigger' | 'repost' }
export type XIntent = 'empty' | 'control' | 'status' | 'build' | 'unclear'

export declare function authorizeTrigger(post: XPost, binding: XRulesBinding): TriggerVerdict
export declare function instructionOf(post: XPost, binding: XRulesBinding): string | null
export declare function logicalPostId(post: XPost): string
export declare function classifyIntent(instruction: string): XIntent
export declare function repositoryFrom(instruction: string): string | null
export declare function destinationRepositoryFrom(instruction: string): string | null
export declare const validGithubAccount: (v: string) => boolean
export declare const validRepositoryName: (v: string) => boolean
export declare function newRepositoryNameFrom(instruction: string): string | null
export declare function derivedRepositoryName(instruction: string, postId: string): string
export declare function isDeictic(instruction: string): boolean
export declare function hasRequestSubstance(instruction: string, artifacts?: readonly ContextArtifact[]): boolean
/** Which of the owner's repositories a word in the instruction names (x.ts projectCandidates' match). */
export declare function projectCandidates(instruction: string, repos: readonly { fullName: string; url: string }[]):
  { projectName: string; urls: string[] } | null

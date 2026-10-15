import { isAbsolute } from 'node:path'
import { validateRepository, shortBaseRef, validateRepositoryIdentity } from './native-delivery.mjs'
import { object, str, bool, fail, clone } from './validation.mjs'

/** Validate the complete input BEFORE persisting it or invoking delivery. */
export function validateNativeDeliveryInput(input) {
  object(input, ['missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body', 'repositoryIdentity'],
    ['missionId', 'workDir', 'repository', 'baseRef', 'baseSha', 'policy', 'title', 'body'])
  if (input.repositoryIdentity !== undefined) validateRepositoryIdentity(input.repositoryIdentity)
  str(input.missionId, 100)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.missionId)) fail('native_delivery_mission_invalid', 400)
  str(input.workDir, 4096)
  if (!isAbsolute(input.workDir)) fail('native_delivery_workdir_invalid', 400)
  validateRepository(input.repository); shortBaseRef(input.baseRef)
  if (typeof input.baseSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baseSha)) fail('native_delivery_sha_invalid', 400)
  object(input.policy, ['allowPush', 'allowPr', 'allowMerge'])
  Object.values(input.policy).forEach(bool)
  if ((input.policy.allowMerge && !input.policy.allowPr) || (input.policy.allowPr && !input.policy.allowPush)) fail('native_delivery_policy_inconsistent', 400)
  str(input.title, 256); str(input.body, 60000, true)
  if (/[\r\n]/.test(input.title)) fail('native_delivery_title_invalid', 400)
  return clone(input)
}

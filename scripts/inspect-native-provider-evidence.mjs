/**
 * Static evidence inventory only. Never prints frames, prompts, user/org/session
 * IDs, model IDs, tokens, SDK result payloads or arbitrary diagnostic strings.
 * Truncated frames are counted, never interpreted as complete evidence.
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve, basename } from 'node:path'
const files = process.argv.slice(2)
if (!files.length) throw new Error('Provide recorded raw-frames.jsonl paths')
for (const path of files) {
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error('Evidence input too large')
  const methods = {}, notificationTypes = {}, settings = []
  let invalid = 0, frames = 0, pendingFields = 0
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    let envelope
    try {
      const row = JSON.parse(line)
      envelope = typeof row.frame === 'string' ? JSON.parse(row.frame) : row.frame
      if (!envelope || typeof envelope !== 'object') throw new Error()
    } catch { invalid++; continue }
    frames++
    const method = envelope.method
    if (/^daemon\.[a-z_]{1,64}$/.test(method)) methods[method] = (methods[method] ?? 0) + 1
    const n = envelope.params?.notification
    if (n && /^[a-z_]{1,64}$/.test(n.type)) notificationTypes[n.type] = (notificationTypes[n.type] ?? 0) + 1
    const actual = envelope.result?.settings ?? (n?.type === 'settings_updated' ? n.settings : null)
    if (actual) {
      const known = ['modelId', 'reasoningEffort', 'interactionMode', 'autonomyLevel', 'availableAutonomyLevels',
        'restrictToolIds', 'missionSettings']
      settings.push({
        source: envelope.result?.settings ? 'rpc_result' : 'notification',
        presentKeys: known.filter(key => Object.hasOwn(actual, key)),
        missionSettingKeys: ['workerModel', 'workerReasoningEffort', 'validationWorkerModel',
          'validationWorkerReasoningEffort', 'skipScrutiny', 'skipUserTesting'].filter(key => Object.hasOwn(actual.missionSettings ?? {}, key)),
        highReported: actual.autonomyLevel === 'high',
        highAvailable: Array.isArray(actual.availableAutonomyLevels) && actual.availableAutonomyLevels.includes('high'),
      })
    }
    if (Object.hasOwn(envelope.result ?? {}, 'pendingPermissions') || Object.hasOwn(envelope.result ?? {}, 'pendingAskUsers')) pendingFields++
  }
  console.log(JSON.stringify({
    input: resolve(path), frames, invalidOrTruncatedFrames: invalid, methods, notificationTypes,
    settings, pendingFields, qualificationProduced: false, basename: basename(path),
  }, null, 2))
}

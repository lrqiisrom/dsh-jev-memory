/**
 * What each workspace was used for.
 *
 * This lives in its own module because two tools need the same answer: the
 * harvester decides the sampling strata with it, and the report groups labelled rows
 * by it. Two copies would drift, and a drifted copy would silently reclassify rows
 * in the headline number.
 *
 * The mapping is the *person's* reading of their own sessions, which is why every
 * entry carries the evidence that settled it:
 *
 *  - `projectSDK` is this plugin, `EchoMind…` a customer-service agent: software.
 *  - `interview` and `algorithm` are revision. An earlier version of this file
 *    treated `interview` as a coding workspace, where it supplied 221 of 240 sampled
 *    rows that are mostly exam answers ("三数之和的时间复杂度是多少").
 *  - `yakumo-main` and `blarify-main` are revision of the person's own past projects
 *    plus document writing — engineering *discussion*, but not building software.
 *  - `satellite-web` is office work: reading a patent specification (.docx) and
 *    keeping an interaction consistent across windows.
 *
 * Every workspace present in the corpus is listed, so nothing falls through to a
 * guessed default. An unlisted workspace is `other` and reported as such, rather
 * than being folded into a class whose rate it would distort.
 *
 * @module eval/lib/task-class
 */

/** What a session was about: built software, revision, office work, or unknown. */
export type TaskClass = 'coding' | 'study' | 'office' | 'other'

/** Workspace directory → class. */
export const WORKSPACE_CLASS: Record<string, TaskClass> = {
  '/Users/rom/Documents/projectSDK': 'coding',
  '/Users/rom/Documents/EchoMind所有代码+详细文档+简历': 'coding',
  '/Users/rom/Documents/ProjectLab/interview': 'study',
  '/Users/rom/Documents/ProjectLab/algorithm': 'study',
  '/Users/rom/PycharmProjects/yakumo-main': 'study',
  '/Users/rom/PycharmProjects/blarify-main': 'study',
  '/Users/rom/WebstormProjects/satellite-web': 'office',
}

/**
 * The class of a session's workspace.
 *
 * @param workspace - the session's `cwd`.
 * @returns its class, `other` when the workspace is not listed.
 */
export function taskClassOf(workspace: string): TaskClass {
  return WORKSPACE_CLASS[workspace] ?? 'other'
}

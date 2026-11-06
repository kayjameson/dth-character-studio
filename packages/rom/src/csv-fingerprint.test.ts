import { describe, expect, it } from 'vitest'

import { POSE_ASSET_TEMPLATES, poseAssetTemplatesFingerprint } from './csv'

describe('poseAssetTemplatesFingerprint', () => {
  it('changes when one value in one template changes', () => {
    const name = 'poseasset-physics-g9.csv'
    const edited = {
      ...POSE_ASSET_TEMPLATES,
      [name]: POSE_ASSET_TEMPLATES[name].replace('BreastHangForward,0.0', 'BreastHangForward,11.0'),
    }
    expect(edited[name]).not.toBe(POSE_ASSET_TEMPLATES[name])
    expect(poseAssetTemplatesFingerprint(edited)).not.toBe(poseAssetTemplatesFingerprint())
  })

  it("doesn't change with line endings", () => {
    const crlf = Object.fromEntries(
      Object.entries(POSE_ASSET_TEMPLATES).map(([k, v]) => [k, v.replace(/\r?\n/g, '\r\n')]),
    )
    expect(poseAssetTemplatesFingerprint(crlf)).toBe(poseAssetTemplatesFingerprint())
  })

  it('covers all three templates', () => {
    expect(Object.keys(POSE_ASSET_TEMPLATES)).toHaveLength(3)
    for (const text of Object.values(POSE_ASSET_TEMPLATES)) expect(text.length).toBeGreaterThan(100)
  })
})

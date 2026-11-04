import { describe, expect, it } from 'vitest'
import { repoRisk } from './repoRisk'

const base = { topics: [] as string[], stars: 300 }
describe('repoRisk', () => {
  it('flags the lure repositories seen on the daily list', () => {
    expect(repoRisk({ ...base, fullName: 'DenColonelWrinkle/ios-unlocker', description: 'Complete standalone iOS Unlocker 2026 setup, ready to run with all features activated.', sizeKb: 1 })?.hide).toBe(true)
    expect(repoRisk({ ...base, fullName: 'VectorLobsterBearing/landr-plugin-bundle', description: 'Landr Plugin Bundle 2026: Full working installer with all essential plugins pre-installed', sizeKb: 1 })?.hide).toBe(true)
  })
  it('only notes tiny brand-new repos with a burst of stars and no language, and does not hide them', () => {
    const r = repoRisk({ ...base, fullName: 'a/b', description: 'A nice thing', sizeKb: 10, createdAt: new Date(Date.now() - 86_400_000).toISOString() })
    expect(r).toMatchObject({ hide: false })
    expect(repoRisk({ ...base, fullName: 'a/b', description: 'A nice thing', sizeKb: 10, language: 'Rust', createdAt: new Date(Date.now() - 86_400_000).toISOString() })).toBeNull()
  })
  it('leaves real projects alone', () => {
    expect(repoRisk({ fullName: 'DeltaProviderGuide/auto-auction-bot', description: 'A free Auction House bot: buys low, posts high', topics: ['rust'], stars: 394, sizeKb: 14_000 })).toBeNull()
    expect(repoRisk({ fullName: 'anthropics/skills', description: 'Public repository for Agent Skills', topics: [], stars: 90_000, sizeKb: 5000 })).toBeNull()
    expect(repoRisk({ fullName: 'x/installer-tools', description: 'Tools to build installers', topics: [], stars: 20, sizeKb: 3000 })).toBeNull()
  })
})

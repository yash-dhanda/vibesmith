// A hand-picked list of public GitHub repositories that hold Claude skills (folders with a SKILL.md). Each one was checked to exist and to
// hold skills on 2026-11-04; `skills` is how many SKILL.md files it had then. Anything here is added the same way as a pasted link.

export type SkillCategory = 'design' | 'frontend' | 'workflow' | 'testing' | 'security' | 'growth' | 'platform' | 'collection'
export type CatalogEntry = { repo: string; name: string; category: SkillCategory; blurb: string; skills: number }

export const CATEGORY_LABEL: Record<SkillCategory, string> = {
  design: 'UI and UX design',
  frontend: 'Frontend and mobile',
  workflow: 'How the agent works',
  testing: 'Browser and testing',
  security: 'Security and code quality',
  growth: 'Marketing, SEO and research',
  platform: 'Platforms and backends',
  collection: 'Big collections',
}

const e = (repo: string, name: string, category: SkillCategory, skills: number, blurb: string): CatalogEntry => ({ repo, name, category, blurb, skills })

export const SKILL_CATALOG: CatalogEntry[] = [
  e('nextlevelbuilder/ui-ux-pro-max-skill', 'UI/UX Pro Max', 'design', 13, 'Design systems, UI styling, slides and brand work from one project analysis.'),
  e('Leonxlnx/taste-skill', 'Taste Skill', 'design', 1, 'Avoids the generic templated look: typography, layout and colour with a point of view.'),
  e('pbakaus/impeccable', 'Impeccable', 'design', 26, 'Design, critique, polish, animate and harden an interface.'),
  e('anthropics/skills', 'Anthropic skills', 'design', 20, 'Official examples: frontend design, canvas, themes, documents, web app testing, MCP servers.'),
  e('vercel-labs/agent-skills', 'Vercel agent skills', 'design', 9, 'React and Next.js best practices, composition patterns, view transitions, web interface guidelines.'),
  e('bencium/bencium-claude-code-design-skill', 'Bencium design', 'design', 16, 'Controlled and innovative UX designer modes, design audit, code conventions.'),
  e('emilkowalski/skill', 'Emil Kowalski', 'design', 16, 'Animation, motion performance, Apple-style design and breaking UIs on purpose to test them.'),
  e('ibelick/ui-skills', 'UI skills', 'design', 9, 'Baseline UI, accessibility fixes, motion performance, metadata fixes, design.md.'),
  e('raphaelsalaja/userinterface-wiki', 'User Interface Wiki', 'design', 1, 'A reference of interface craft: details that make UI feel good.'),
  e('claudekit/frontend-design-pro-demo', 'Frontend Design Pro', 'design', 2, 'Many distinct aesthetics, from Swiss minimal to cyberpunk.'),
  e('heydamir/unslop', 'Unslop', 'design', 1, 'Strips generic AI patterns out of copy and design.'),
  e('alchaincyf/huashu-design', 'Huashu design', 'design', 1, 'A single design skill for building polished pages.'),
  e('shadcn-ui/ui', 'shadcn/ui', 'design', 2, 'Use and migrate shadcn components the way the project intends.'),
  e('figma/mcp-server-guide', 'Figma', 'design', 34, 'Design to code, Code Connect, design systems. Needs the Figma MCP server.'),
  e('expo/skills', 'Expo', 'frontend', 25, 'Expo and EAS: building, updating, native UI, app store releases.'),
  e('remotion-dev/skills', 'Remotion', 'frontend', 13, 'Make videos with React: captions, maps, interactivity, best practices.'),
  e('vercel/ai', 'Vercel AI SDK', 'frontend', 14, 'Build AI features with the AI SDK: providers, streaming, tests.'),
  e('obra/superpowers', 'Superpowers', 'workflow', 15, 'Brainstorm, plan, test first, review and finish a branch, step by step.'),
  e('garrytan/gstack', 'gstack', 'workflow', 72, 'Plan reviews, QA, browsing, shipping and retros in one toolbox.'),
  e('JuliusBrussee/caveman', 'Caveman', 'workflow', 28, 'Terse replies and lean builds that save tokens.'),
  e('mattpocock/skills', 'Matt Pocock skills', 'workflow', 39, 'Code review, bug diagnosis, domain modelling, implement-from-spec.'),
  e('thedotmack/claude-mem', 'claude-mem', 'workflow', 44, 'Memory: carries what was learned from one session to the next.'),
  e('glittercowboy/taches-cc-resources', 'Taches resources', 'workflow', 12, 'Create skills, hooks, MCP servers, plans and subagents.'),
  e('muratcankoylan/Agent-Skills-for-Context-Engineering', 'Context engineering', 'workflow', 24, 'Context management, evaluation and research agents.'),
  e('anthropics/claude-plugins-official', 'Claude plugins (official)', 'workflow', 33, 'Anthropic-curated plugins and the skills inside them.'),
  e('anthropics/knowledge-work-plugins', 'Knowledge work plugins', 'workflow', 252, 'Skills for sales, legal, finance, data, product and support work.'),
  e('SawyerHood/dev-browser', 'Dev browser', 'testing', 1, 'Drive a real browser to look at and test what was built.'),
  e('lackeyjb/playwright-skill', 'Playwright skill', 'testing', 1, 'Write and run Playwright browser tests on the fly.'),
  e('microsoft/playwright-cli', 'Playwright CLI', 'testing', 3, 'Official Playwright command line skills: automate and triage tests.'),
  e('trailofbits/skills', 'Trail of Bits security', 'security', 97, 'Security audit, vulnerability scanners and audit preparation.'),
  e('getsentry/skills', 'Sentry skills', 'security', 30, 'Code review, simplifying, commits and settings audits used at Sentry.'),
  e('coreyhaines31/marketingskills', 'Marketing skills', 'growth', 53, 'A/B tests, ads, analytics, copy, SEO and app store optimization.'),
  e('AgriciDaniel/claude-seo', 'Claude SEO', 'growth', 35, 'SEO audits, schema, sitemaps, local SEO and AI-search visibility.'),
  e('firecrawl/skills', 'Firecrawl', 'growth', 37, 'Scrape, search and crawl the web into clean data.'),
  e('K-Dense-AI/claude-scientific-skills', 'Scientific skills', 'growth', 177, 'Research tools across biology, chemistry, data science and statistics.'),
  e('huggingface/skills', 'Hugging Face', 'growth', 26, 'Hugging Face CLI, datasets, training and deployment.'),
  e('stripe/ai', 'Stripe', 'platform', 60, 'Payments, Connect, billing and the docs, done the way Stripe recommends.'),
  e('cloudflare/skills', 'Cloudflare', 'platform', 19, 'Workers, agents, email, Zero Trust and the CLI.'),
  e('supabase/agent-skills', 'Supabase', 'platform', 2, 'Supabase and Postgres best practices.'),
  e('clerk/skills', 'Clerk', 'platform', 22, 'Authentication for every framework, billing and the backend API.'),
  e('neondatabase/agent-skills', 'Neon', 'platform', 15, 'Neon Postgres: auth, functions, storage and realtime.'),
  e('prisma/skills', 'Prisma', 'platform', 10, 'Prisma ORM setup, client API, migrations and drivers.'),
  e('upstash/skills', 'Upstash', 'platform', 14, 'Redis, queues and vector data on Upstash.'),
  e('wix/skills', 'Wix', 'platform', 69, 'Wix apps, the design system, headless sites and the docs.'),
  e('openai/skills', 'OpenAI skills', 'platform', 44, 'OpenAI’s own skills: ChatGPT apps, Figma, deploys and more.'),
  e('wshobson/agents', 'wshobson agents', 'collection', 185, 'A large set of agents and skills across languages and tasks.'),
  e('alirezarezvani/claude-skills', 'alirezarezvani skills', 'collection', 478, 'Hundreds of skills for engineering, product, marketing and more.'),
  e('jeffallan/claude-skills', 'jeffallan skills', 'collection', 67, 'Full-stack developer skills by language and framework.'),
  e('ComposioHQ/awesome-claude-skills', 'Awesome Claude Skills', 'collection', 864, 'The most-starred community collection. Large download.'),
  e('github/awesome-copilot', 'Awesome Copilot', 'collection', 475, 'GitHub’s community collection of skills and instructions. Large download.'),
]

// A few repos that go well together, added in one click.
export const SKILL_PACKS: { id: string; name: string; blurb: string; repos: string[] }[] = [
  { id: 'design', name: 'UI and UX starter', blurb: 'The best design skills to start with.', repos: ['nextlevelbuilder/ui-ux-pro-max-skill', 'Leonxlnx/taste-skill', 'pbakaus/impeccable', 'anthropics/skills', 'vercel-labs/agent-skills', 'heydamir/unslop'] },
  { id: 'motion', name: 'Motion and polish', blurb: 'Animation, accessibility and interface craft.', repos: ['emilkowalski/skill', 'ibelick/ui-skills', 'raphaelsalaja/userinterface-wiki', 'bencium/bencium-claude-code-design-skill'] },
  { id: 'builder', name: 'Build it properly', blurb: 'Plan, test, review and check in a browser.', repos: ['obra/superpowers', 'mattpocock/skills', 'SawyerHood/dev-browser', 'lackeyjb/playwright-skill', 'getsentry/skills'] },
]

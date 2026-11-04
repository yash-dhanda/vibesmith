// Project ideas for the "What to build" gallery. Pure data: every goal is written so a three-agent Crew can finish it in one run.

export const CATEGORIES = ['Web apps', 'Bots', 'Automation and scripts', 'CLI tools', 'Games', 'Data and dashboards', 'AI tools', 'Mobile and PWA', 'Browser extensions', 'Developer tools', 'Business and money tools'] as const
export type IdeaCategory = (typeof CATEGORIES)[number]
export type IdeaLevel = 'starter' | 'intermediate' | 'ambitious'
export type Idea = {
  id: string
  title: string
  pitch: string
  category: IdeaCategory
  level: IdeaLevel
  hours: string // rough Crew time, for example "1-3"
  stack: string
  features: string[]
  goal: string
  tags: string[]
}

const done = (test: string) => ` Cover the core logic with automated tests so \`${test}\` passes, and write a README with install and run steps.`
const N = (body: string) => body + done('npm test')
const PY = (body: string) => body + done('pytest')

const web = 'Web apps', bots = 'Bots', auto = 'Automation and scripts', cli = 'CLI tools', games = 'Games', data = 'Data and dashboards', ai = 'AI tools', mob = 'Mobile and PWA', ext = 'Browser extensions', dev = 'Developer tools', biz = 'Business and money tools'

export const IDEAS: Idea[] = [
  // ---- Web apps ----
  {
    id: 'portfolio-site', title: 'Portfolio site with a blog', category: web, level: 'starter', hours: '1-2', stack: 'Vite, TypeScript, plain CSS',
    pitch: 'A fast personal site that lists your projects and posts, so recruiters and friends see your work in one place.',
    features: ['Project cards generated from a projects.json file', 'Blog posts written as markdown files', 'Dark and light theme that follows the system', 'Contact section with mailto and social links', 'Open Graph tags and a sitemap'],
    goal: N('Build a static portfolio site with Vite and TypeScript and no UI framework. It has a home page with a short intro, a projects grid rendered from `src/data/projects.json` (title, summary, tags, repo and live links), and a blog whose posts are markdown files in `content/posts` rendered at build time with front matter for title and date. Add a theme toggle that defaults to the system setting and remembers the choice, a responsive layout that works from 360px wide, a sitemap, and Open Graph tags on every page. Acceptance: `npm run build` produces a `dist` folder, the project list and post list come from the data files, and adding a new post or project needs no code change.'),
    tags: ['portfolio', 'static', 'blog', 'career'],
  },
  {
    id: 'url-shortener', title: 'URL shortener with click stats', category: web, level: 'starter', hours: '1-2', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'Turn long links into short ones and see how often each is opened, a classic that teaches routing and databases.',
    features: ['Create a short link with an optional custom slug', 'Redirects that count clicks with a timestamp', 'Stats page per link with clicks per day', 'QR code for every short link', 'Link expiry date', 'Rate limit on creating links'],
    goal: N('Build a URL shortener with Node, Express and SQLite (better-sqlite3). A page has a form to paste a URL and an optional custom slug; the API validates the URL (http or https only), rejects reserved or taken slugs, and returns the short link. `GET /:slug` redirects with 302 and records a click row (time, referrer). A stats page at `/stats/:slug` shows total clicks, a clicks-per-day table for the last 14 days and an SVG QR code, and links can have an optional expiry after which they return 410. Add a simple per-IP rate limit on link creation. Acceptance: invalid URLs and duplicate slugs return clear errors, and clicks are counted exactly once per redirect.'),
    tags: ['links', 'express', 'sqlite', 'api'],
  },
  {
    id: 'expense-splitter', title: 'Expense splitter for friend groups', category: web, level: 'intermediate', hours: '2-4', stack: 'Node, Express, SQLite, vanilla JS or React',
    pitch: 'Track who paid for the trip or the hostel party and get the smallest set of payments that settles everyone.',
    features: ['Groups with members and no login, shared by a link', 'Add expenses split equally, by shares or by exact amounts', 'Live balance per person', 'Settle-up screen with the fewest transfers', 'UPI deep link per payment', 'Export the group as CSV'],
    goal: N('Build an expense splitter web app with Node, Express and SQLite. A group is created with a name and member names and is opened through an unguessable link, with no accounts. Expenses have a title, amount in rupees, who paid and a split mode (equal, by shares, or exact amounts that must add up to the total); store money as integer paise. The balances view shows who owes whom, and the settle-up view computes a minimal list of transfers using a greedy match of the largest debtor and creditor, each with a `upi://pay` link and a mark-as-paid button. Add CSV export. Acceptance: balances always sum to zero, rounding leftovers are assigned deterministically, and unit tests cover uneven splits.'),
    tags: ['money', 'groups', 'upi', 'students'],
  },
  {
    id: 'queue-token-system', title: 'Queue and token system', category: web, level: 'intermediate', hours: '3-5', stack: 'Node, Express, WebSocket (ws), SQLite, vanilla JS',
    pitch: 'People take a token on their phone, a big screen shows who is next, and staff call the next person, so nobody stands in a line.',
    features: ['Visitor page: take a token for a service and see your position', 'Display screen showing now serving and the next five', 'Staff panel: call next, recall, skip, mark done', 'Several counters and several services', 'Estimated wait from recent service times', 'Live updates over WebSocket'],
    goal: N('Build a queue and token system for places like a college office or clinic, using Node, Express, ws and SQLite. Visitors open `/` , pick a service and get a token such as A-014 with their position in line; the page updates live. A staff page `/staff` lets a logged-in counter (a shared PIN per counter is enough) call the next token, recall, skip or mark done. A TV page `/display` shows the tokens now being served per counter and the next five waiting, and speaks nothing but updates instantly. Estimate the waiting time from the average of the last ten service durations. Acceptance: two counters never get the same token, tokens reset daily, and tests cover the queue state machine.'),
    tags: ['queue', 'realtime', 'campus', 'websocket'],
  },
  {
    id: 'habit-tracker', title: 'Habit tracker with streaks', category: web, level: 'starter', hours: '1-2', stack: 'Vite, TypeScript, localStorage',
    pitch: 'Check off daily habits, keep streaks alive and see a year heatmap, with all data kept on your own device.',
    features: ['Add habits with a weekly target or every day', 'One-tap check-in for today and a short backfill window', 'Current and best streak per habit', 'Year heatmap in the style of a contribution graph', 'Export and import as JSON', 'Reminder note when a streak is about to break'],
    goal: N('Build a habit tracker as a single-page app with Vite and TypeScript, storing everything in localStorage. A habit has a name, colour and a schedule (every day or chosen weekdays). The home screen lists today\'s habits with a one-tap check; the habit page shows the current streak, best streak, completion rate for 30 days and a 53-week heatmap drawn in SVG. Streak logic must respect the schedule, so skipped days that were not planned do not break a streak. Add JSON export and import and a banner for habits whose streak ends tonight. Acceptance: the streak function is pure and unit tested, including month and year boundaries.'),
    tags: ['habits', 'streak', 'heatmap', 'productivity'],
  },
  {
    id: 'live-polls', title: 'Live polls with QR join', category: web, level: 'intermediate', hours: '2-4', stack: 'Node, Express, Server-Sent Events, vanilla JS',
    pitch: 'Run a poll in class or a club meeting: people scan a QR code, vote on their phone, and the bars move live.',
    features: ['Create a poll with 2 to 8 options and a join code', 'QR code that opens the voting page', 'One vote per device with a cookie plus IP guard', 'Live results chart for the host', 'Close and reopen voting', 'Results export as CSV'],
    goal: N('Build a live poll app with Node and Express using Server-Sent Events for updates and no database beyond an in-memory store with a JSON snapshot on disk. The host page creates a poll (question, 2 to 8 options, single or multiple choice) and gets a join code, a voting link and an SVG QR code. The voting page works on phones, accepts one vote per browser (cookie) and rejects repeat votes from the same cookie, and shows a thank-you plus live results if the host allows it. The host view shows animated bars and a total, with buttons to close, reopen and export CSV. Acceptance: votes are never lost when two arrive together, and a closed poll rejects votes with a clear message.'),
    tags: ['realtime', 'sse', 'classroom', 'qr'],
  },
  {
    id: 'campus-lost-found', title: 'Campus lost and found board', category: web, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite, multer, vanilla JS',
    pitch: 'A board where students post found or lost items with a photo, and owners claim them with a proof question.',
    features: ['Post lost or found with photo, place and date', 'Search and filter by category, block and date', 'Claim flow where the finder asks a proof question', 'Moderator page to approve and remove posts', 'Auto-hide items after 60 days', 'No phone numbers shown publicly'],
    goal: N('Build a lost and found board with Node, Express, SQLite and multer for image uploads (JPEG or PNG under 3 MB, resized to 800px). Anyone can post a lost or found item with a title, category, location, date and optional photo; found posts also take a proof question the owner must answer. The public board supports text search and filters and never shows contact details; a claim sends the claimant\'s answer and contact to the poster\'s private inbox page that is reached through a secret link. A moderator page protected by an admin password approves new posts before they appear, and posts expire after 60 days. Acceptance: uploads reject non-images, moderation hides a post immediately, and tests cover search, expiry and claims.'),
    tags: ['campus', 'uploads', 'moderation', 'students'],
  },
  {
    id: 'attendance-planner', title: 'Attendance and bunk calculator', category: web, level: 'starter', hours: '1-3', stack: 'Vite, TypeScript, localStorage',
    pitch: 'Enter your subjects and classes attended, and see exactly how many classes you can skip or must attend to stay above 75%.',
    features: ['Subjects with attended and total classes', 'Target percentage setting, default 75', 'Safe bunks left and classes needed per subject', 'Weekly timetable that predicts the future percentage', 'Mark today present, absent or cancelled', 'Everything saved on the device'],
    goal: N('Build an attendance planner as a single-page app with Vite and TypeScript and localStorage. The user adds subjects with attended and total class counts and a target percentage (default 75). For every subject show the current percentage, how many more classes can be missed while staying at or above target, or how many consecutive classes must be attended to get back to target, using exact integer maths. Add a weekly timetable editor and a today screen where each class can be marked present, absent or cancelled, which updates the counts. Add a what-if box ("if I skip the next 3 classes of OS"). Acceptance: the bunk and recovery formulas are pure functions tested at the exact 75% boundary and with zero classes held.'),
    tags: ['students', 'attendance', 'calculator', 'campus'],
  },
  {
    id: 'timetable-sharing', title: 'Study group scheduler', category: web, level: 'intermediate', hours: '2-4', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'Friends mark when they are free, and the app shows the best slots for a group study session.',
    features: ['Create a group and share a link', 'Paint weekly free hours on a grid', 'Heatmap of overlap across members', 'Top three suggested slots with who can attend', 'Pick a slot and export an .ics calendar file', 'No sign-up, just names'],
    goal: N('Build a group availability scheduler with Node, Express and SQLite. A group has a link; each member enters a name and paints their free hours on a 7-day by 14-hour grid by dragging, and can edit later using a secret edit token saved in the browser. The group page overlays all members as a heatmap and lists the top three slots of at least one hour ranked by how many members are free, naming who is missing. The organiser can lock a slot and download an `.ics` file for it. Acceptance: overlap computation is a pure tested function, a single member can never be double-counted, and the grid works with touch as well as mouse.'),
    tags: ['students', 'calendar', 'groups', 'scheduling'],
  },

  // ---- Bots ----
  {
    id: 'telegram-study-bot', title: 'Telegram study bot', category: bots, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, Telegraf, SQLite',
    pitch: 'A study companion in Telegram that tracks deadlines, runs pomodoro sessions and quizzes you from your own notes.',
    features: ['/subject and /deadline commands with due dates', 'Morning digest of what is due this week', 'Pomodoro timer that messages you when it ends', 'Study time log with a weekly summary', 'Quiz mode that asks questions from notes you add', 'Per-user data kept in SQLite'],
    goal: N('Build a Telegram study bot with Node, TypeScript, Telegraf and SQLite. Commands: `/subject add|list|remove`, `/deadline add <subject> <date> <title>` and `/deadlines`, `/pomodoro [minutes]` which sends a message when the focus block ends and logs the minutes to that subject, `/week` for a study-time summary, and `/note add <subject> <question> | <answer>` plus `/quiz <subject>` which asks cards at random and checks the answer. A scheduler sends a daily digest at the hour each user sets with `/digest 8`, using the Asia/Kolkata time zone by default. All data is per Telegram user id. Keep the token in `BOT_TOKEN` read from the environment with a `.env.example`. Acceptance: the date parser, scheduler and quiz selection are tested without calling Telegram by separating handlers from the Telegraf wiring.'),
    tags: ['telegram', 'students', 'study', 'sqlite'],
  },
  {
    id: 'telegram-expense-bot', title: 'Telegram expense logger', category: bots, level: 'starter', hours: '1-3', stack: 'Node, TypeScript, Telegraf, SQLite',
    pitch: 'Send "250 lunch" to a bot and it logs the spend; ask for a summary any time. The fastest expense tracker is the chat you already have open.',
    features: ['Free-text logging such as "250 food lunch with Ravi"', 'Categories learned from the first word', '/today, /month and /category summaries', 'Monthly budget with a warning at 80%', 'CSV export sent as a file', 'Undo the last entry'],
    goal: N('Build a Telegram expense logger with Node, TypeScript, Telegraf and SQLite. A message like `250 food lunch` or `1200 transport` parses to amount, category and note; unknown categories are created on the fly, and amounts accept `1.5k`. Commands: `/today`, `/month` (total plus per-category breakdown as aligned text), `/budget <amount>` which warns when 80% and 100% are crossed, `/undo` which removes the last entry, and `/export` which sends a CSV file. Store money as integer paise and scope everything to the sending user. Read `BOT_TOKEN` from the environment and provide `.env.example`. Acceptance: the message parser is a pure function with tests for odd inputs, and budgets warn exactly once per threshold per month.'),
    tags: ['telegram', 'money', 'expense', 'parser'],
  },
  {
    id: 'telegram-reminder-bot', title: 'Telegram reminder bot', category: bots, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript, Telegraf, SQLite, chrono-node',
    pitch: 'Type "remind me tomorrow 6pm to submit the lab file" and get pinged on time, including repeating reminders.',
    features: ['Natural-language times', 'Repeats: daily, weekly, every weekday', 'Snooze buttons on the reminder', '/list and /cancel with inline buttons', 'Time zone per user, default Asia/Kolkata', 'Survives restarts'],
    goal: N('Build a Telegram reminder bot with Node, TypeScript, Telegraf, SQLite and the chrono-node parser. A message such as `remind me tomorrow 6pm to submit the lab file` or `every weekday 7am gym` creates a reminder stored with its next fire time in UTC and the user\'s time zone. A scheduler loop checks every 15 seconds, sends due reminders with inline buttons for Done, Snooze 10 min and Snooze 1 hour, and schedules the next occurrence for repeating ones. `/list` shows upcoming reminders with a cancel button each, and `/tz Asia/Kolkata` sets the zone. Pending reminders must survive a restart and must never fire twice. Acceptance: tests cover parsing, next-occurrence maths across a daylight-saving zone, and the scheduler with a fake clock.'),
    tags: ['telegram', 'scheduler', 'nlp', 'productivity'],
  },
  {
    id: 'discord-mod-bot', title: 'Discord moderation bot', category: bots, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, discord.js v14, SQLite',
    pitch: 'Keep a community server clean with warnings, timeouts, an automod word filter and a mod log channel.',
    features: ['Slash commands: warn, timeout, kick, ban, purge', 'Warning history per member', 'Auto-timeout after N warnings', 'Automod for banned words and invite links', 'Mod log channel with embeds', 'Permission checks on every command'],
    goal: N('Build a Discord moderation bot with Node, TypeScript, discord.js v14 and SQLite, registering slash commands per guild. Commands: `/warn user reason`, `/warnings user`, `/timeout user minutes reason`, `/kick`, `/ban`, `/purge count`, `/modlog channel` and `/automod words add|remove|list`. Every action checks that the invoking member has the matching Discord permission and that the bot\'s role is above the target, then writes an embed to the configured mod log channel and a row to SQLite. Three warnings in 30 days automatically time the member out for one hour. A message listener deletes messages containing banned words or unapproved invite links and logs them. Read the token from `DISCORD_TOKEN`. Acceptance: permission and hierarchy checks plus the warning escalation are unit tested apart from Discord I/O.'),
    tags: ['discord', 'moderation', 'slash-commands', 'sqlite'],
  },
  {
    id: 'discord-ticket-bot', title: 'Discord ticket bot', category: bots, level: 'intermediate', hours: '3-4', stack: 'Node, TypeScript, discord.js v14, SQLite',
    pitch: 'Members press a button to open a private support channel; staff reply and close it, and a transcript is saved.',
    features: ['Panel message with an Open ticket button', 'Private channel per ticket visible to staff only', 'Claim and close buttons for staff', 'HTML or text transcript sent to a log channel', 'Limit of one open ticket per member', 'Ticket categories via a select menu'],
    goal: N('Build a Discord ticket bot with Node, TypeScript, discord.js v14 and SQLite. `/ticket-panel` posts a message with a select menu of categories and an Open ticket button. Opening creates a private text channel named `ticket-0042` visible only to the member and the staff role, with a first message holding Claim and Close buttons; a member may have at most one open ticket. Closing asks for confirmation, then saves a plain-text transcript of all messages to a file, posts it in the configured log channel, and deletes the channel after 10 seconds. Configuration (staff role, log channel, category) is set with `/ticket-setup` and stored per guild. Acceptance: ticket numbering is sequential per guild, the one-ticket rule is enforced, and the transcript formatter is tested.'),
    tags: ['discord', 'support', 'buttons', 'transcript'],
  },
  {
    id: 'discord-levels-bot', title: 'Discord levels and leaderboard bot', category: bots, level: 'starter', hours: '2-3', stack: 'Node, TypeScript, discord.js v14, SQLite',
    pitch: 'Members earn XP for chatting and in voice study rooms, level up, and compete on a weekly leaderboard.',
    features: ['XP per message with a 60 second cooldown', 'Voice minutes counted for study rooms', '/rank card and /leaderboard', 'Role rewards at set levels', 'Weekly reset with a winner announcement', 'Ignore channels list'],
    goal: N('Build a Discord levels bot with Node, TypeScript, discord.js v14 and SQLite. Each message earns 15 to 25 XP at most once per 60 seconds per member, and each minute in a voice channel marked as a study room earns 10 XP. Level thresholds follow `5 * level^2 + 50 * level + 100`. `/rank` replies with an embed showing level, XP and progress bar, `/leaderboard` shows the top ten for the week and all time, and `/levelrole level role` grants a role at a level. Every Monday 00:00 IST the weekly board resets and the winner is announced in a chosen channel. Channels can be ignored with `/xp-ignore`. Acceptance: XP and level maths are pure and tested, and cooldowns cannot be bypassed by sending messages in parallel.'),
    tags: ['discord', 'leaderboard', 'community', 'voice'],
  },
  {
    id: 'minecraft-afk-bot', title: 'Minecraft AFK bot with status page', category: bots, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, mineflayer',
    pitch: 'A bot that joins your server, stays alive, reconnects when kicked and reports its state on a small web page.',
    features: ['Auto reconnect with exponential backoff', 'Auto eat when hunger is low', 'Anti-AFK movement on a timer', 'In-game chat commands for allowed players', 'HTTP status page with health, food, position and uptime', 'Config in a JSON file, no secrets in code'],
    goal: N('Build a Minecraft bot with Node, TypeScript and mineflayer. It reads host, port, username and auth mode from `config.json` and `.env`, joins the server and reconnects after any kick or error using exponential backoff capped at 5 minutes. While connected it eats from the inventory when food drops below 14, performs a small look-and-jump movement every 45 to 90 seconds, and responds to whispers from players on an allow-list with `!pos`, `!inv`, `!come` and `!stop`. A tiny HTTP server on localhost serves `/status` JSON and an HTML page with health, food, position, dimension and uptime. Acceptance: the reconnect backoff, command parser and allow-list logic are tested in isolation from the network, and the bot never crashes on unexpected packets.'),
    tags: ['minecraft', 'mineflayer', 'automation', 'reconnect'],
  },
  {
    id: 'minecraft-discord-bridge', title: 'Minecraft and Discord chat bridge', category: bots, level: 'intermediate', hours: '3-4', stack: 'Node, TypeScript, mineflayer, discord.js',
    pitch: 'Chat flows both ways between a Minecraft server and a Discord channel, with joins, leaves and deaths shown too.',
    features: ['Minecraft chat posted to Discord and back', 'Join, leave and death messages as embeds', 'Player list command in Discord', 'Message sanitising so nobody can ping @everyone', 'Reconnect on both sides', 'Rate limiting to avoid spam kicks'],
    goal: N('Build a chat bridge with Node, TypeScript, mineflayer and discord.js. One process logs a mineflayer bot into the Minecraft server and a Discord bot into one channel. Minecraft chat lines become Discord messages prefixed with the player name, and Discord messages from humans are sent into game chat as `[Discord] name: text`, split to the 256 character limit. Joins, leaves and deaths post as small embeds. A `/players` slash command lists who is online. Strip mentions and control characters from every cross-posted message, ignore the bot\'s own messages to prevent loops, and rate-limit game chat to one message per 1.5 seconds with a queue. Reconnect each side independently. Acceptance: sanitising, splitting and loop prevention are unit tested.'),
    tags: ['minecraft', 'discord', 'bridge', 'mineflayer'],
  },
  {
    id: 'telegram-file-converter-bot', title: 'Telegram file converter bot', category: bots, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, Telegraf, sharp, pdf-lib',
    pitch: 'Send photos or documents to a bot and get a PDF, a compressed image or a different format back.',
    features: ['Several photos merged into one PDF', 'Image resize and compress with a quality choice', 'Convert PNG, JPG and WEBP', 'Merge and split PDFs by page range', 'Size limit and clean-up of temporary files', 'Inline buttons to pick the action'],
    goal: N('Build a Telegram file converter bot with Node, TypeScript, Telegraf, sharp and pdf-lib. When a user sends images, the bot asks with inline buttons what to do: make one PDF in the order sent (collect until the user presses Done), compress to a chosen quality, or convert to PNG, JPG or WEBP. When a user sends a PDF, offer Split by page range such as `2-5,9` or Extract page as image. Download to a temp folder, enforce a 20 MB limit, process, send the result and delete all temporary files even on failure. Keep per-user sessions in memory with a 10 minute timeout. Read `BOT_TOKEN` from the environment. Acceptance: the conversion functions work on fixture files in tests without Telegram, and page-range parsing rejects bad input.'),
    tags: ['telegram', 'files', 'pdf', 'images'],
  },

  // ---- Automation and scripts ----
  {
    id: 'price-tracker', title: 'Price tracker with Telegram alerts', category: auto, level: 'intermediate', hours: '2-4', stack: 'Python, requests, BeautifulSoup, SQLite',
    pitch: 'Watch product pages, store the price over time, and get a Telegram message when it drops below your target.',
    features: ['Add a product by URL with a CSS selector for the price', 'Price history in SQLite', 'Target price and percentage-drop alerts', 'Polite scheduling with a delay and a user agent', 'Telegram notification', 'CSV export and a text chart of history'],
    goal: PY('Build a price tracker script in Python with requests, BeautifulSoup and SQLite. A `products.yaml` lists items with a name, URL, a CSS selector for the price element and a target price. Running `python tracker.py check` fetches each page with a timeout, a clear user agent and a random 2 to 6 second delay between sites, parses prices such as "₹1,299.00" into integer paise, stores each reading, and sends a Telegram message through the Bot API when the price falls under the target or drops more than 10% since the last reading. `python tracker.py history <name>` prints a table and an ASCII sparkline, and `export` writes CSV. Parse failures are logged and never stop other products. Credentials come from environment variables with a `.env.example`. Acceptance: the price parser and alert rules are tested with saved HTML fixtures and no network access.'),
    tags: ['scraping', 'price', 'telegram', 'cron'],
  },
  {
    id: 'folder-organizer', title: 'Downloads folder organizer', category: auto, level: 'starter', hours: '1-2', stack: 'Node, TypeScript, chokidar',
    pitch: 'Watches your Downloads folder and files things into Images, Docs, Installers and so on, with a dry run and an undo.',
    features: ['Rules in a YAML file by extension, name pattern or size', 'Dry-run mode that only prints what would move', 'Watch mode for new files', 'Skips partial downloads', 'Undo log to reverse the last run', 'Never overwrites: adds a numeric suffix'],
    goal: N('Build a folder organizer CLI with Node, TypeScript and chokidar. A `rules.yaml` maps extensions, filename regexes and size ranges to target subfolders. `organize run <folder>` moves matching files, `--dry-run` only prints the plan, and `organize watch <folder>` applies rules to new files once they stop growing, ignoring `.crdownload`, `.part` and `.tmp`. A name clash never overwrites; it appends `-1`, `-2`. Every move is appended to a JSON undo log, and `organize undo` reverses the most recent batch in reverse order. Acceptance: tests on a temporary directory cover rule priority, collisions, dry run and undo, and the tool never touches files outside the given folder.'),
    tags: ['files', 'watcher', 'cli', 'productivity'],
  },
  {
    id: 'page-change-watcher', title: 'Web page change watcher', category: auto, level: 'starter', hours: '1-3', stack: 'Node, TypeScript, cheerio, SQLite',
    pitch: 'Get told when a notice board, results page or product page changes, with a readable diff of what is new.',
    features: ['Watch list with URL and optional CSS selector', 'Only the chosen part of the page is compared', 'Text diff showing added and removed lines', 'Telegram or desktop notification', 'Check interval per page', 'History of changes'],
    goal: N('Build a page change watcher with Node, TypeScript, cheerio and SQLite. A `watches.json` lists pages with URL, an optional CSS selector and an interval in minutes. A runner fetches each page when due, extracts the selected element\'s text (normalising whitespace and dropping scripts), compares it with the last stored snapshot, and when it differs stores the new snapshot and sends a notification containing a short added/removed line diff to Telegram (`BOT_TOKEN`, `CHAT_ID` from the environment) or prints it if Telegram is not configured. `watcher history <name>` lists past changes. A failing page backs off and never blocks the others. Acceptance: diffing and extraction are tested with HTML fixtures, with no network calls in tests.'),
    tags: ['scraping', 'notifications', 'notices', 'watcher'],
  },
  {
    id: 'backup-script', title: 'Incremental backup tool', category: auto, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript',
    pitch: 'Back up chosen folders to a drive with snapshots that share unchanged files, plus retention and verification.',
    features: ['Snapshot folders named by date', 'Hard links for unchanged files to save space', 'Include and exclude globs', 'Retention: keep daily, weekly, monthly', 'Verify command comparing checksums', 'Dry run and a summary of bytes copied'],
    goal: N('Build an incremental backup CLI with Node and TypeScript, without external services. `backup run` reads `backup.json` (sources, destination, exclude globs), creates a dated snapshot folder under the destination, and for each file hard-links it to the previous snapshot when size and mtime match (falling back to a copy when linking fails) and copies it otherwise. Print a summary of files copied, linked and bytes written; `--dry-run` copies nothing. `backup prune` keeps the last 7 daily, 4 weekly and 6 monthly snapshots and deletes the rest. `backup verify <snapshot>` re-hashes files with SHA-256 against a manifest written during the run. Acceptance: tests on temporary directories prove unchanged files share an inode, pruning never deletes the newest snapshot, and a modified file is detected by verify.'),
    tags: ['backup', 'files', 'cli', 'retention'],
  },
  {
    id: 'daily-digest', title: 'Morning digest to Telegram', category: auto, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript, rss-parser',
    pitch: 'One message every morning with the weather, your deadlines and the headlines from feeds you choose.',
    features: ['RSS and Atom feed list', 'Weather from a free no-key API for your city', 'Deadlines from a simple local file', 'De-duplication so you never see the same item twice', 'Runs from cron or a systemd timer', 'Dry-run prints the message'],
    goal: N('Build a morning digest script with Node, TypeScript and rss-parser. Configuration in `digest.json` lists feed URLs (with max items each), a city for the Open-Meteo forecast API (no key), and a path to a `deadlines.md` file with lines like `2026-12-03 CSE111 assignment`. The script builds one Telegram message with a weather summary, deadlines due in the next 7 days sorted by date, and the newest unseen headlines per feed, remembering seen item ids in a JSON state file so repeats never appear. Messages longer than 4096 characters are split. `--dry-run` prints instead of sending. Include a sample systemd timer and cron line in the README. Acceptance: formatting, de-duplication and deadline filtering are tested with fixtures and a fake clock.'),
    tags: ['telegram', 'rss', 'cron', 'weather'],
  },
  {
    id: 'git-auto-backup', title: 'Notes auto-commit and sync', category: auto, level: 'starter', hours: '1-2', stack: 'Node, TypeScript, git',
    pitch: 'Turn a notes or assignments folder into a git repo that commits and pushes itself every few minutes when files change.',
    features: ['Watches the folder with debounce', 'Commit messages listing changed files', 'Push with retry when the network returns', 'Ignore patterns', 'Status command showing last sync', 'Lock to avoid two instances running'],
    goal: N('Build an auto-commit daemon with Node and TypeScript that shells out to the git CLI. `autosync init <folder>` creates a repo if needed and writes `.autosync.json` (debounce seconds, ignore globs, remote). `autosync watch` watches the folder, waits for 60 seconds of quiet, then stages changes and commits with a message such as `Update 3 files: notes/os.md, ...`, then pushes; a failed push is retried with backoff and the commit is kept locally. `autosync status` shows the last commit, last successful push and pending files. A lock file prevents two instances on one folder. Acceptance: tests use temporary git repos with a local bare remote to prove commit grouping, ignored files, and push retry after the remote appears.'),
    tags: ['git', 'notes', 'sync', 'watcher'],
  },

  // ---- CLI tools ----
  {
    id: 'todo-cli', title: 'Terminal todo list', category: cli, level: 'starter', hours: '1-2', stack: 'Node, TypeScript',
    pitch: 'A tiny todo manager for the terminal with priorities, due dates and tags, stored in a plain JSON file.',
    features: ['add, list, done, edit, remove commands', 'Priorities and due dates like "fri" or "2026-12-01"', 'Filter by tag, due today, overdue', 'Colourful readable table', 'Data file location configurable', 'Shell completion script'],
    goal: N('Build a todo CLI named `td` with Node and TypeScript and no heavy framework. Commands: `td add "text" -p high -d fri -t uni`, `td ls [--tag t] [--today] [--overdue]`, `td done <id>`, `td edit <id>`, `td rm <id>` and `td clear-done`. Dates accept ISO format, `today`, `tomorrow` and weekday names. Data is a JSON file in the user\'s config directory, overridable with `TD_FILE`, written atomically so a crash cannot corrupt it. List output is a coloured aligned table sorted by priority then due date, with overdue items highlighted. Provide bash and zsh completion. Acceptance: date parsing and sorting are pure tested functions, and invalid input prints a helpful message with a non-zero exit code.'),
    tags: ['cli', 'todo', 'productivity', 'json'],
  },
  {
    id: 'dupe-finder', title: 'Duplicate file finder', category: cli, level: 'starter', hours: '1-2', stack: 'Node, TypeScript',
    pitch: 'Find identical files wasting disk space, fast, and remove the extra copies safely.',
    features: ['Groups by size, then partial hash, then full hash', 'Report with wasted space', 'Interactive keep-one prompt', 'Replace duplicates with hard links', 'Exclude patterns', 'Never deletes without confirmation or --yes'],
    goal: N('Build a duplicate file finder CLI with Node and TypeScript. `dupes scan <folder...>` walks the folders without following symlinks, groups files by size, then by a hash of the first 64 KB, then by the full SHA-256, so unique files are never fully read. It prints each group with paths and the total space wasted. `dupes clean` offers per group to keep one file (default: the oldest) and delete the rest after a typed confirmation, or `--hardlink` to replace extras with hard links; `--dry-run` shows the plan and `--yes` skips prompts. Support `--exclude` globs and a minimum size. Acceptance: tests with temporary files prove that identical content is grouped regardless of name, same-size different files are not, and nothing is deleted in dry-run mode.'),
    tags: ['files', 'cli', 'disk', 'hashing'],
  },
  {
    id: 'file-converter-cli', title: 'All-in-one file converter', category: cli, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, sharp, pdf-lib, marked',
    pitch: 'One command to convert images, merge PDFs, turn markdown into HTML or PDF and CSV into JSON.',
    features: ['Images: PNG, JPG, WEBP, resize and quality', 'PDF: merge, split, images to PDF', 'Markdown to HTML with a clean stylesheet', 'CSV to JSON and JSON to CSV', 'Batch mode with globs', 'Clear error when a conversion is not supported'],
    goal: N('Build a converter CLI named `conv` with Node, TypeScript, sharp, pdf-lib and marked. `conv photo.png photo.webp --quality 80 --width 1200` converts and resizes images; `conv a.pdf b.pdf -o merged.pdf` merges and `conv in.pdf --pages 2-4 -o out.pdf` extracts pages; `conv *.jpg -o album.pdf` makes a PDF with one image per page; `conv notes.md notes.html` renders markdown with an embedded stylesheet; `conv data.csv data.json` and the reverse convert tabular data with correct quoting. Output format comes from the target extension, glob inputs are supported, existing outputs are never overwritten without `--force`, and unsupported pairs list what is supported. Acceptance: tests convert small fixture files for every supported pair and check the outputs open correctly.'),
    tags: ['converter', 'pdf', 'images', 'markdown'],
  },
  {
    id: 'git-stats-cli', title: 'Git contribution stats', category: cli, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript, git',
    pitch: 'See your commit streaks, busiest weekdays and a terminal heatmap for any repo or a whole folder of repos.',
    features: ['Commits per day with a heatmap in the terminal', 'Current and longest streak', 'Busiest weekday and hour', 'Lines added and removed per week', 'Scan a folder of repositories', 'Filter by author email'],
    goal: N('Build `gitstats`, a CLI with Node and TypeScript that parses `git log --numstat --format=...` output. `gitstats .` prints a 52-week terminal heatmap using block characters and ANSI colours, the total commits, current and longest daily streak, the busiest weekday and hour of day as small bar charts, and lines added and removed per week for the last 12 weeks. `gitstats ~/code --author you@example.com` scans every repository one level down and merges the days. Support `--since`, `--json` for machine output, and a clear message when no commits match. Use only the git CLI. Acceptance: the log parser and streak calculation are pure functions with tests built from sample log text, including timezone-day boundaries.'),
    tags: ['git', 'stats', 'heatmap', 'terminal'],
  },
  {
    id: 'flashcards-cli', title: 'Spaced-repetition flashcards in the terminal', category: cli, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript',
    pitch: 'Study from the terminal with a proper spaced-repetition schedule, so exam revision stops being random re-reading.',
    features: ['Decks as simple markdown or CSV files', 'SM-2 scheduling', 'Review session showing only due cards', 'Stats: due today, retention, streak', 'Add cards from the command line', 'Import from Anki-style CSV'],
    goal: N('Build a flashcard CLI named `fc` with Node and TypeScript. Decks are files in a folder: markdown with `Q:`/`A:` blocks or two-column CSV. `fc review [deck]` shows each due card question, waits for Enter, shows the answer, and takes a grade of 0 to 5 (or again/hard/good/easy keys); scheduling follows the SM-2 algorithm with ease factor, interval and repetition count stored in a sidecar JSON per deck. `fc stats` shows cards due today, new cards, mature cards and the review streak, `fc add deck "question" "answer"` appends a card and `fc import file.csv` loads Anki-style exports. Acceptance: the SM-2 function is pure and tested against known interval sequences, a failed card resets repetitions, and cards are never shown twice in one session unless failed.'),
    tags: ['study', 'spaced-repetition', 'exam', 'terminal'],
  },

  // ---- Games ----
  {
    id: 'snake-polished', title: 'Snake with levels and high scores', category: games, level: 'starter', hours: '1-2', stack: 'Vite, TypeScript, Canvas',
    pitch: 'A well-finished snake game with touch controls, speed levels and a local high-score table.',
    features: ['Canvas rendering with a fixed-step game loop', 'Arrow keys, WASD and swipe controls', 'Speed increases with score', 'Wrap-around or walls mode', 'High scores saved locally', 'Pause and restart'],
    goal: N('Build a Snake game with Vite, TypeScript and the Canvas API. Use a fixed-timestep loop separate from rendering, a grid of 20 by 20 cells, keyboard (arrows and WASD) and swipe controls, and a rule that makes it impossible to reverse into yourself within one tick. Speed rises every 5 foods; a setting switches between walls and wrap-around. Store the top 10 scores with initials in localStorage. Add pause (space), a game-over overlay, a score display and a layout that scales to small screens. Keep game logic (movement, food placement, collision) in pure functions apart from drawing. Acceptance: tests cover collision, growth, food never spawning on the snake, and rapid double key presses.'),
    tags: ['canvas', 'arcade', 'typescript', 'highscore'],
  },
  {
    id: 'typing-speed-test', title: 'Typing speed test', category: games, level: 'starter', hours: '1-2', stack: 'Vite, TypeScript',
    pitch: 'Measure words per minute and accuracy, find your weak keys, and watch your progress over weeks.',
    features: ['Timed 15, 30 and 60 second modes', 'Live WPM and accuracy', 'Per-key error stats', 'Word lists: common words, code symbols', 'History chart in SVG', 'Results shareable as an image'],
    goal: N('Build a typing test with Vite and TypeScript. The user picks a duration (15, 30 or 60 seconds) and a word list (common English, or a code-symbols list), sees the text with the current word highlighted, and gets live WPM and accuracy as they type; correct, wrong and extra characters are coloured differently and backspace works within the current word. At the end show net WPM, raw WPM, accuracy and the five most-missed keys. Save each result in localStorage and draw a progress line chart with SVG. Provide a result card that can be downloaded as a PNG using a canvas. Acceptance: the WPM and accuracy calculation are pure functions with tests, using the standard definition of five characters per word.'),
    tags: ['typing', 'practice', 'charts', 'frontend'],
  },
  {
    id: 'minesweeper-custom', title: 'Minesweeper with custom boards', category: games, level: 'starter', hours: '1-3', stack: 'Vite, TypeScript',
    pitch: 'The classic with a safe first click, flags, chording, custom board sizes and a best-times list.',
    features: ['Beginner, intermediate, expert and custom boards', 'First click is always safe', 'Right-click or long-press to flag', 'Chording on numbers', 'Timer and best times per difficulty', 'Keyboard play'],
    goal: N('Build Minesweeper with Vite and TypeScript using DOM or canvas rendering. Support presets (9x9 with 10 mines, 16x16 with 40, 30x16 with 99) and custom sizes with validation that mines never exceed cells minus 9. Mines are placed after the first reveal so the first click and its neighbours are safe. Revealing a zero floods open neighbours iteratively (no recursion limits), right-click or long-press toggles flags, and clicking a satisfied number chords. Track a timer and store best times per preset locally. Add arrow-key navigation with space to reveal and F to flag. Acceptance: pure board functions are tested for safe first click, flood fill on a large empty board, win and loss detection, and mine-count display.'),
    tags: ['puzzle', 'classic', 'frontend', 'algorithms'],
  },
  {
    id: 'daily-word-game', title: 'Daily five-letter word game', category: games, level: 'intermediate', hours: '2-4', stack: 'Vite, TypeScript, localStorage',
    pitch: 'A guess-the-word puzzle with its own word list, a new word each day and a shareable result grid.',
    features: ['Six guesses, coloured feedback per letter', 'Same word for everyone each day, no server', 'On-screen and physical keyboard', 'Streak and guess distribution stats', 'Hard mode', 'Copyable emoji-free result grid'],
    goal: N('Build a daily five-letter word game with Vite and TypeScript, using your own original word lists (about 800 answer words and 4000 valid guesses, generated from a public-domain list and committed as plain text). The answer for a day is chosen deterministically from the date in the Asia/Kolkata time zone, so everyone gets the same word without a server. Six guesses give green, yellow or grey feedback with correct handling of repeated letters, an on-screen keyboard that shows the best-known state of each letter, and a hard mode that forces reuse of found hints. Save streaks and the guess distribution locally and offer a share button that copies a text grid using letters like G, Y and dot instead of emoji. Acceptance: the feedback function is tested on repeated-letter cases and the daily pick on date boundaries.'),
    tags: ['word', 'daily', 'puzzle', 'statistics'],
  },
  {
    id: 'live-quiz-game', title: 'Live multiplayer quiz', category: games, level: 'ambitious', hours: '4-7', stack: 'Node, Express, ws, vanilla JS',
    pitch: 'A host runs a quiz on the big screen while everyone answers on their phones, with speed-based scoring and a podium.',
    features: ['Quiz editor with timed multiple-choice questions', 'Join with a short code and a nickname', 'Host screen: question, countdown, answer counts', 'Score based on correctness and speed', 'Leaderboard after each question and final podium', 'Reconnect without losing the player'],
    goal: N('Build a live multiplayer quiz with Node, Express and ws. A host creates a quiz in an editor (title, questions with 2 to 4 options, one correct, time limit of 5 to 60 seconds) saved as JSON on disk, then starts a game and gets a 6-character join code. Players open `/play`, enter the code and a nickname, and see only the answer buttons; the host screen shows the question, a countdown, how many have answered, and after the timer the correct answer and a bar chart of choices. Points are `1000 * (1 - elapsed / limit / 2)` for correct answers, streak bonuses are optional, and the leaderboard shows the top five after each question and a podium at the end. A player who reconnects with the same nickname and stored token resumes. Acceptance: the server owns the clock, late answers score zero, a player can answer once per question, and the scoring and game state machine are tested without sockets.'),
    tags: ['multiplayer', 'websocket', 'quiz', 'realtime'],
  },
  {
    id: 'tower-defense-lite', title: 'Tower defense mini game', category: games, level: 'ambitious', hours: '4-7', stack: 'Vite, TypeScript, Canvas',
    pitch: 'Place towers along a path, survive ten waves and balance upgrades against money, all in one small original game.',
    features: ['Path with grid placement', 'Three tower types with upgrades', 'Ten waves with escalating enemies', 'Money, lives and a sell value', 'Game speed control and pause', 'Data-driven balance in a JSON file'],
    goal: N('Build an original tower defense game with Vite, TypeScript and Canvas. A map (defined as data) has an enemy path and buildable cells; the player places three kinds of towers (rapid, area, slow) that target the enemy furthest along the path within range, can upgrade each twice and sell for 70% value. Ten waves are described in `waves.json` with enemy types, counts and spacing, and enemy stats and tower stats live in `balance.json` so tuning needs no code change. Show money, lives, wave number, a start-wave button, pause and 1x/2x speed. Use a fixed-timestep simulation separate from drawing, and draw all art with simple shapes so there are no copyrighted assets. Acceptance: targeting, damage, and wave spawning are tested as pure simulation steps, and a scripted run can win and lose deterministically.'),
    tags: ['canvas', 'strategy', 'simulation', 'data-driven'],
  },

  // ---- Data and dashboards ----
  {
    id: 'personal-finance-dashboard', title: 'Personal finance dashboard', category: data, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite, Chart.js or SVG',
    pitch: 'Import your bank or UPI statement CSV, auto-categorise spending and see where the money goes each month.',
    features: ['CSV import with column mapping', 'Rule-based categories you can edit', 'Monthly totals, category pie and trend line', 'Budgets per category with progress', 'Recurring payment detection', 'All data stays local'],
    goal: N('Build a personal finance dashboard with Node, Express, SQLite and a small charting approach (inline SVG or Chart.js). The import page accepts a CSV, lets the user map columns for date, description, debit and credit, and previews 10 rows before saving; duplicate rows from re-importing the same file are skipped by a hash of date, amount and description. A rules table maps text patterns (for example "swiggy" or "zomato") to categories and is applied on import, with a screen to re-run rules. The dashboard shows this month\'s income, spend and savings, a category breakdown, a 12-month trend, per-category budgets with progress bars, and a list of likely recurring payments (same payee and amount roughly monthly). Store amounts as integer paise. Acceptance: parsing handles quotes, commas in numbers and dd/mm/yyyy dates, and categorisation and duplicate detection are unit tested.'),
    tags: ['finance', 'csv', 'charts', 'budget'],
  },
  {
    id: 'study-hours-dashboard', title: 'Study hours dashboard', category: data, level: 'starter', hours: '1-3', stack: 'Vite, TypeScript, SVG charts',
    pitch: 'Log study sessions per subject and see where your hours really go, with weekly goals and streaks.',
    features: ['Start and stop a timer or add a past session', 'Hours per subject and per day charts', 'Weekly goal with progress', 'Heatmap of study days', 'Best study hour of the day', 'Export to CSV'],
    goal: N('Build a study hours dashboard as a single-page app with Vite and TypeScript, stored in localStorage. The user defines subjects with colours, starts a live timer or adds a session manually (subject, date, minutes, note). Charts drawn in plain SVG show hours per day for the last 30 days stacked by subject, total per subject as a bar chart, a 12-week heatmap, and the hours of the day when most study happens. A weekly goal in hours shows a progress ring and a streak of weeks that met the goal. Provide CSV export and import. Acceptance: aggregation functions (per day, per subject, per week, streaks) are pure and tested, including sessions that cross midnight and Monday week starts.'),
    tags: ['students', 'charts', 'productivity', 'timer'],
  },
  {
    id: 'cgpa-planner', title: 'SGPA and CGPA planner', category: data, level: 'starter', hours: '1-2', stack: 'Vite, TypeScript',
    pitch: 'Calculate SGPA and CGPA on a 10-point scale and find out which grades you need to reach a target.',
    features: ['Courses with credits and grade points', 'Semester SGPA and running CGPA', 'Target CGPA solver for the remaining semesters', 'What-if: change a grade and see the effect', 'Configurable grading scale', 'Saved locally and exportable'],
    goal: N('Build an SGPA and CGPA planner with Vite and TypeScript. Users add semesters, each with courses that have credits and a letter grade; the default scale is O=10, A+=9, A=8, B+=7, B=6, C=5, D=4, F=0 and the scale can be edited. SGPA is the credit-weighted mean for a semester and CGPA is the credit-weighted mean across all graded courses. A target planner takes the desired final CGPA, the credits already done and the credits left, and shows the average grade point needed in the remaining credits, saying clearly when the target is impossible. A what-if mode lets a grade be changed temporarily to see the new SGPA and CGPA. Save locally and export as JSON. Acceptance: all formulas are pure and tested, including courses without grades and rounding to two decimals.'),
    tags: ['students', 'calculator', 'grades', 'campus'],
  },
  {
    id: 'uptime-monitor', title: 'Uptime monitor and status page', category: data, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite',
    pitch: 'Check your sites and APIs every minute, keep the history and publish a clean status page with alerts when something goes down.',
    features: ['HTTP checks with expected status and timeout', 'Response time history and uptime percentage', 'Status page with incidents', 'Telegram or webhook alert after 2 failures', 'Recovery notice', 'Retention of 30 days'],
    goal: N('Build an uptime monitor with Node, Express and SQLite. A `monitors.json` or admin page defines checks (URL, method, expected status, timeout, interval). A scheduler runs checks in parallel with a concurrency limit, stores status and response time, and opens an incident after 2 consecutive failures and closes it on the next success, sending a Telegram message or generic webhook on both transitions. The public page `/` shows each monitor\'s current state, 24-hour response-time sparkline, 30-day uptime percentage and a list of recent incidents; `/api/status` returns the same as JSON. Rows older than 30 days are pruned. Acceptance: the incident state machine and uptime maths are tested with a fake clock and a fake checker, and one slow check never delays others.'),
    tags: ['monitoring', 'status', 'alerts', 'api'],
  },
  {
    id: 'csv-explorer', title: 'CSV explorer in the browser', category: data, level: 'intermediate', hours: '3-5', stack: 'Vite, TypeScript, PapaParse or custom parser',
    pitch: 'Drop in any CSV and instantly get a sortable table, column statistics and quick charts, without uploading anything.',
    features: ['Drag and drop, handles large files', 'Column type detection', 'Sort, filter and search', 'Stats per column: min, max, mean, nulls, unique', 'Group by one column with a bar chart', 'Download the filtered result'],
    goal: N('Build a CSV explorer as a client-only web app with Vite and TypeScript. Dropping a CSV (up to 50 MB) parses it in a Web Worker so the page stays responsive, detects each column as number, date or text, and shows a virtualised table that sorts by any column and filters with a search box and per-column conditions. A side panel shows column statistics (count, nulls, unique, min, max, mean, median), and a Group by control aggregates (count, sum, mean) by a chosen column and draws a bar chart in SVG. The filtered view downloads as CSV. Nothing is sent to a server. Acceptance: parsing handles quoted newlines and different delimiters, and type detection, filtering and aggregation are pure functions with tests.'),
    tags: ['csv', 'analysis', 'client-side', 'charts'],
  },
  {
    id: 'github-profile-dashboard', title: 'GitHub activity dashboard', category: data, level: 'intermediate', hours: '2-4', stack: 'Node, Express, GitHub REST API, SVG',
    pitch: 'Enter a username and see languages, top repos, commit streaks and activity patterns drawn as clean charts.',
    features: ['Languages breakdown across repos', 'Top repos by stars and recent activity', 'Contribution calendar from public events', 'Rate-limit aware with a cache', 'Optional token via environment', 'Shareable page per user'],
    goal: N('Build a GitHub activity dashboard with Node and Express that calls the public GitHub REST API (optionally authenticated through `GITHUB_TOKEN`). `/u/:user` shows the profile summary, a language bar computed from the user\'s non-fork repos weighted by repo size, the top repositories by stars and by recent push, and a 12-week activity grid built from public events. Responses are cached on disk for 15 minutes, rate-limit headers are respected with a friendly message when exhausted, and all upstream calls have timeouts. Charts are inline SVG. Acceptance: tests mock the API with fixtures and cover aggregation, caching and the rate-limit path, and no test touches the network.'),
    tags: ['github', 'api', 'charts', 'profile'],
  },

  // ---- AI tools ----
  {
    id: 'notes-to-flashcards', title: 'Notes to flashcards', category: ai, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, any chat-completions API, SQLite',
    pitch: 'Paste lecture notes or upload a PDF and get exam-style flashcards you can review and export to Anki.',
    features: ['Paste text or upload a PDF', 'Chunking so long notes work', 'Cards you can edit, delete or regenerate', 'Duplicate detection', 'Anki-compatible CSV export', 'Provider and model set by environment variables'],
    goal: N('Build a notes-to-flashcards web app with Node, TypeScript, Express and SQLite that calls an OpenAI-compatible chat completions endpoint configured by `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. Users paste text or upload a PDF (extract text with pdf-parse), the text is split into chunks of about 1500 characters on paragraph boundaries, and each chunk is sent with a prompt that returns strict JSON cards with question, answer and a difficulty tag. Validate and repair the JSON, drop near-duplicate questions, and show the cards in an editable list with delete and regenerate buttons. Export as Anki-style tab-separated CSV. Acceptance: the LLM call sits behind a small interface so tests use a fake model, and tests cover chunking, JSON validation with malformed replies, and duplicate removal.'),
    tags: ['llm', 'study', 'flashcards', 'pdf'],
  },
  {
    id: 'pdf-study-chat', title: 'Chat with your course PDFs', category: ai, level: 'ambitious', hours: '5-8', stack: 'Node, TypeScript, SQLite, OpenAI-compatible API',
    pitch: 'Ask questions about your textbooks and slides and get answers that quote the page they came from.',
    features: ['Upload several PDFs per course', 'Page-aware chunking', 'Hybrid search: keyword plus embeddings', 'Answers with page citations', 'Says "not in the documents" when unsure', 'Conversation history per course'],
    goal: N('Build a document Q&A app with Node, TypeScript, Express and SQLite. Users create a course and upload PDFs; text is extracted per page and split into overlapping chunks that keep the file name and page number. Index chunks with SQLite FTS5 for keyword search and with embeddings from an OpenAI-compatible endpoint (`LLM_BASE_URL`, `LLM_API_KEY`, `EMBED_MODEL`, `LLM_MODEL`), stored as blobs, and answer questions by merging the top results of both searches with reciprocal rank fusion. The prompt instructs the model to answer only from the supplied excerpts, cite as [file p.12], and say it cannot find the answer otherwise; the UI shows citations that open the excerpt. Keep the chat history per course. Acceptance: tests with fake embedding and chat clients cover chunking, rank fusion and the not-found behaviour, and uploads over 30 MB are rejected.'),
    tags: ['llm', 'rag', 'pdf', 'study'],
  },
  {
    id: 'commit-message-writer', title: 'AI commit message writer', category: ai, level: 'starter', hours: '1-2', stack: 'Node, TypeScript, git, OpenAI-compatible API',
    pitch: 'Run one command and get a clear commit message based on your staged diff, which you can accept or edit.',
    features: ['Reads the staged diff, truncated safely', 'Conventional commit style option', 'Shows the message and asks to commit, edit or retry', 'Skips lock files and binaries', 'Works with any OpenAI-compatible endpoint', 'Never sends files matching .env patterns'],
    goal: N('Build `aicommit`, a CLI with Node and TypeScript. It runs `git diff --cached`, drops lock files, binary files and anything matching secret-like names such as `.env*` or `*.pem`, truncates the rest to a safe token budget while keeping each file\'s header, and sends it to an OpenAI-compatible endpoint configured by `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`. The prompt asks for a subject line under 72 characters in the imperative mood and an optional body, in conventional commit style when `--conventional` is passed. The CLI prints the message and prompts: commit, edit in `$EDITOR`, regenerate or abort; `--yes` commits immediately. Acceptance: diff filtering, truncation and the prompt builder are pure and tested, the model client is injected so tests need no network, and nothing is ever sent when the staged diff is empty.'),
    tags: ['llm', 'git', 'cli', 'productivity'],
  },
  {
    id: 'resume-tailor', title: 'Resume tailor and keyword checker', category: ai, level: 'intermediate', hours: '2-4', stack: 'Node, TypeScript, Express, OpenAI-compatible API',
    pitch: 'Paste your resume and a job post to see missing keywords and get honest rewrites of your bullets, never invented experience.',
    features: ['Keyword match score between resume and job post', 'List of missing and present skills', 'Bullet rewrites that keep facts unchanged', 'Length and format checks', 'Export as clean text or markdown', 'Local only, no resume stored'],
    goal: N('Build a resume tailoring tool with Node, TypeScript and Express and a single-page UI. The user pastes a resume and a job description. A deterministic analyser extracts skills and keywords from both using a bundled skills dictionary, reports a match percentage, present skills and missing skills, and flags resume issues (over two pages of text, missing contact line, bullets without numbers). On request it calls an OpenAI-compatible model (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) to rewrite chosen bullets for the job, with a system prompt that forbids adding employers, tools or numbers that are not in the original, and the UI shows original and rewrite side by side. Nothing is stored on disk. Acceptance: the analyser and the prompt guard are tested, and the model is injected so tests use a fake.'),
    tags: ['llm', 'career', 'text', 'students'],
  },
  {
    id: 'mock-test-generator', title: 'Mock test generator', category: ai, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, Express, SQLite, OpenAI-compatible API',
    pitch: 'Turn a syllabus topic list into a timed multiple-choice mock exam with scoring and explanations for wrong answers.',
    features: ['Enter subject, topics and difficulty', 'Generated MCQs with four options and an explanation', 'Timed test mode and review mode', 'Score by topic to show weak areas', 'Question bank saved for reuse', 'Validation that exactly one answer is correct'],
    goal: N('Build a mock test generator with Node, TypeScript, Express and SQLite. The user enters a subject, a list of topics and a count; the server asks an OpenAI-compatible model (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) for strict-JSON multiple-choice questions with four options, the correct index, a topic tag and a short explanation, validates each (exactly four distinct options, valid index) and retries invalid ones up to twice. Questions go into a bank so later tests can reuse them. A test page has a countdown timer, question navigator and autosubmit at zero; the result page shows the score, a per-topic breakdown that highlights weak topics, and each wrong answer with its explanation. Acceptance: validation and scoring are pure and tested, and the model is injected so tests run offline.'),
    tags: ['llm', 'exam', 'quiz', 'students'],
  },
  {
    id: 'telegram-ai-assistant', title: 'Telegram assistant with memory', category: ai, level: 'ambitious', hours: '4-7', stack: 'Node, TypeScript, Telegraf, SQLite, OpenAI-compatible API',
    pitch: 'A private assistant bot that remembers facts you tell it, keeps conversations per topic and can set reminders.',
    features: ['Chat with streaming-style edits to one message', 'Long-term memory the user can view and delete', 'Conversation summaries to stay within context limits', 'Tool calls for reminders and notes', 'Allow-list so only you can use it', 'Daily usage limit'],
    goal: N('Build a private Telegram assistant with Node, TypeScript, Telegraf, SQLite and an OpenAI-compatible chat API (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Only Telegram user ids listed in `ALLOWED_IDS` are served. Each chat keeps recent messages; when they exceed a token budget, the oldest are summarised into a stored summary. `/remember <fact>`, `/memories` and `/forget <id>` manage long-term facts that are added to the system prompt. The model may call two tools, `set_reminder(time, text)` and `save_note(text)`, which the bot executes and confirms. Replies are sent by editing one message as text arrives, respecting Telegram\'s edit rate limits. A configurable daily message limit protects the API budget. Acceptance: context trimming, tool dispatch and the allow-list are tested using a fake model.'),
    tags: ['llm', 'telegram', 'assistant', 'memory'],
  },

  // ---- Mobile and PWA ----
  {
    id: 'pwa-expense-tracker', title: 'Offline expense tracker PWA', category: mob, level: 'intermediate', hours: '3-5', stack: 'Vite, TypeScript, IndexedDB, service worker',
    pitch: 'Install it on your phone, add expenses in two taps with no signal, and see monthly summaries.',
    features: ['Installable with a manifest and icons', 'Works offline with a service worker', 'Quick add with amount, category and note', 'Monthly summary and category chart', 'Recurring expenses', 'Backup and restore as JSON'],
    goal: N('Build an offline-first expense tracker PWA with Vite and TypeScript, storing data in IndexedDB. Provide a web app manifest with icons and a service worker that precaches the app shell and serves it offline. The home screen has a numeric keypad quick add (amount, category chips, optional note, date defaulting to today), a list of the month\'s entries with swipe or button delete, and a summary with a category donut chart in SVG. Recurring expenses (monthly rent, subscriptions) generate entries on their due dates when the app opens. Backup downloads a JSON file and restore validates and merges one. Use integer paise. Acceptance: Lighthouse-style checks in a test confirm the manifest fields, storage functions are tested with a fake IndexedDB, and the layout works on a 360px screen.'),
    tags: ['pwa', 'offline', 'money', 'indexeddb'],
  },
  {
    id: 'pwa-pomodoro', title: 'Pomodoro focus timer PWA', category: mob, level: 'starter', hours: '1-3', stack: 'Vite, TypeScript, service worker',
    pitch: 'A focus timer that keeps running with the screen off, tracks sessions per task and shows your weekly focus time.',
    features: ['Focus, short break and long break cycles', 'Timer based on timestamps so it never drifts', 'Notification and sound at the end', 'Screen wake lock option', 'Tasks with a session count', 'Weekly focus chart'],
    goal: N('Build a Pomodoro PWA with Vite and TypeScript. The timer stores a target end timestamp instead of counting ticks, so it stays correct after the tab is suspended; a cycle runs focus (25 min), short break (5), and a long break (15) after four focus blocks, all configurable. At the end it plays a sound, shows a Notification when permission is granted, and optionally keeps the screen awake with the Wake Lock API. Users attach each session to a task with a name, and a weekly SVG bar chart shows focus minutes per day. The app is installable, works offline through a service worker, and saves data in localStorage. Acceptance: the timer state machine is a pure function tested with a fake clock including pause, resume and a phone sleeping through an entire break.'),
    tags: ['pwa', 'focus', 'timer', 'productivity'],
  },
  {
    id: 'pwa-notes', title: 'Offline markdown notes PWA', category: mob, level: 'intermediate', hours: '3-5', stack: 'Vite, TypeScript, IndexedDB, service worker',
    pitch: 'Fast notes with markdown preview, tags and full-text search that work offline and export to plain files.',
    features: ['Markdown editor with live preview', 'Tags and pinned notes', 'Search across all notes as you type', 'Offline and installable', 'Export all notes as a zip of .md files', 'Import markdown files'],
    goal: N('Build a notes PWA with Vite and TypeScript using IndexedDB for storage. The UI has a notes list with search, pinned notes first and tag filters, and an editor with a split view on wide screens and a preview toggle on phones, rendering markdown safely (no raw HTML execution). Search is a small inverted index kept in memory and rebuilt on load, matching words anywhere in title, body and tags. Notes autosave after 500 ms of inactivity. Export builds a zip of `.md` files with front matter for tags (write a minimal zip writer or use fflate), and import accepts several `.md` files. Add a manifest and service worker for offline use. Acceptance: search ranking, markdown sanitising and export contents are tested.'),
    tags: ['pwa', 'notes', 'markdown', 'offline'],
  },
  {
    id: 'qr-attendance-scanner', title: 'QR attendance scanner', category: mob, level: 'intermediate', hours: '3-5', stack: 'Vite, TypeScript, getUserMedia, jsQR',
    pitch: 'Scan students\' QR codes with a phone camera to mark attendance, and export the sheet when the class ends.',
    features: ['Camera scanning in the browser', 'Roster import from CSV', 'Duplicate scan protection', 'Manual add for missing codes', 'Live present and absent counts', 'Export attendance as CSV'],
    goal: N('Build a QR attendance PWA with Vite, TypeScript and jsQR. The teacher imports a roster CSV (id, name), starts a session with a title, and the app opens the rear camera with getUserMedia and decodes frames about ten times per second; a scanned code whose text matches a roster id marks the student present with a time, plays a short beep and shows the name, while unknown codes show a warning and repeated scans of the same id within the session are ignored. A manual list allows toggling anyone. Counters show present and absent, and Export downloads a CSV with every student, status and time. A page generates a printable sheet of QR codes from the roster. Acceptance: roster parsing, scan handling and export are tested apart from the camera, and the app works offline once loaded.'),
    tags: ['pwa', 'camera', 'qr', 'campus'],
  },
  {
    id: 'mess-menu-app', title: 'Hostel mess menu app', category: mob, level: 'intermediate', hours: '3-5', stack: 'Expo, React Native, TypeScript, AsyncStorage',
    pitch: 'See today\'s mess menu, rate meals, and get a notification before lunch, built as a real phone app.',
    features: ['Weekly menu loaded from a JSON file', 'Today view with the next meal highlighted', 'Rate meals with stars and a note', 'Average rating per dish', 'Local notification before each meal', 'Works offline'],
    goal: N('Build a mess menu app with Expo, React Native and TypeScript using AsyncStorage. A bundled `menu.json` holds the weekly menu with breakfast, lunch, snacks and dinner times and dishes; the Today screen highlights the meal happening now or next and counts down to it, and a Week screen shows the full table. Users rate each meal from one to five stars with an optional note, saved locally, and a Stats screen lists the best and worst rated dishes. Schedule local notifications with expo-notifications fifteen minutes before each meal, each toggleable in settings. Acceptance: the logic that picks the current or next meal across midnight and week boundaries is pure and tested, ratings aggregate correctly, and the app type-checks.'),
    tags: ['expo', 'react-native', 'campus', 'notifications'],
  },
  {
    id: 'student-toolkit-pwa', title: 'Student toolkit PWA', category: mob, level: 'starter', hours: '2-3', stack: 'Vite, TypeScript, service worker',
    pitch: 'One installable app with the small tools students use daily: scientific calculator, unit converter, GPA, timer and notes scratchpad.',
    features: ['Scientific calculator with history', 'Unit converter for length, mass, temperature, data', 'SGPA calculator', 'Countdown to exams', 'Scratchpad that saves itself', 'Works offline'],
    goal: N('Build a student toolkit PWA with Vite and TypeScript, with a bottom tab bar for five tools. The calculator uses a proper expression parser (no `eval`) supporting parentheses, powers, roots, trig in degrees or radians and a history list. The converter handles length, mass, temperature, area, speed and data size with a swap button. An SGPA calculator takes credits and grade points. Exam countdowns store a name and date and show days left. A scratchpad autosaves text. The app is installable with a manifest, works offline via a service worker and keeps data in localStorage. Acceptance: the expression parser and converter are pure functions with thorough tests, including operator precedence, unary minus and invalid input.'),
    tags: ['pwa', 'calculator', 'students', 'tools'],
  },

  // ---- Browser extensions ----
  {
    id: 'tab-session-saver', title: 'Tab session saver', category: ext, level: 'starter', hours: '1-3', stack: 'Chrome extension (Manifest V3), TypeScript',
    pitch: 'Save all open tabs as a named session and restore them later, so a research session or exam revision set is never lost.',
    features: ['Save the current window as a named session', 'Restore in a new window', 'Search sessions and tabs', 'Remove a tab from a saved session', 'Export and import JSON', 'Popup and keyboard shortcut'],
    goal: N('Build a Manifest V3 browser extension in TypeScript, bundled with Vite or esbuild. The popup lists saved sessions and has Save current window (name defaults to the date and time). A session stores tab titles, URLs and pinned state, never page content. Restore opens the tabs in a new window with `chrome.windows.create`, and a single tab can be opened or removed. Search filters sessions and tabs by text. Provide Export and Import as JSON with validation, a command bound to a keyboard shortcut, and use only the `tabs` and `storage` permissions. Acceptance: the storage layer and session transformations are pure and tested with a mocked `chrome` object, `npm run build` outputs a loadable `dist` folder, and the README explains how to load it unpacked.'),
    tags: ['extension', 'tabs', 'productivity', 'manifest-v3'],
  },
  {
    id: 'focus-blocker', title: 'Focus site blocker', category: ext, level: 'intermediate', hours: '3-4', stack: 'Chrome extension (Manifest V3), TypeScript',
    pitch: 'Block distracting sites during study hours, with a daily time allowance and a friction screen instead of a hard wall.',
    features: ['Block list with schedule by weekday and hour', 'Daily allowance per site', 'Friction page with a wait and a typed reason', 'Statistics of blocked attempts', 'Focus session button for 25 minutes', 'Options page and sync across devices'],
    goal: N('Build a Manifest V3 extension in TypeScript that blocks distracting sites using declarativeNetRequest dynamic rules. The options page manages a list of domains, a weekly schedule (days and hours when blocking is active) and an optional daily allowance in minutes per domain, tracked by a service worker through tab activity. A blocked navigation redirects to an extension page showing the site, a 10 second wait, and a text box that must contain a typed reason before a 5 minute pass is granted. A popup starts a 25 minute focus session that blocks the whole list regardless of schedule. Keep statistics of blocked attempts per day. Acceptance: schedule evaluation and allowance accounting are pure and tested with a fake clock, and the build outputs a loadable `dist` folder with load instructions in the README.'),
    tags: ['extension', 'focus', 'blocker', 'productivity'],
  },
  {
    id: 'page-highlighter', title: 'Highlighter and page notes', category: ext, level: 'intermediate', hours: '3-5', stack: 'Chrome extension (Manifest V3), TypeScript',
    pitch: 'Highlight text on any page, add a note, and find everything you marked later across all sites.',
    features: ['Select text and highlight in four colours', 'Highlights restored when the page is reopened', 'Optional note per highlight', 'Library page grouped by site with search', 'Export as markdown', 'Works offline, stored locally'],
    goal: N('Build a Manifest V3 extension in TypeScript with a content script that lets the user select text and pick a colour from a small floating toolbar to highlight it. Persist each highlight in `chrome.storage.local` keyed by URL, storing the selected text, a few words of surrounding context and a DOM range described by XPath and offsets, and restore highlights on load with a fallback that searches for the text plus context when the XPath fails. Each highlight can have a note. A library page lists highlights grouped by site and date with full-text search and Export as markdown with source links. Acceptance: range serialisation, restoration fallback and the markdown export are tested in jsdom, and the README describes how to load the build.'),
    tags: ['extension', 'notes', 'reading', 'study'],
  },
  {
    id: 'copy-as-markdown', title: 'Copy as markdown extension', category: ext, level: 'starter', hours: '1-2', stack: 'Chrome extension (Manifest V3), TypeScript',
    pitch: 'Copy the page link, a selection or all tab links as clean markdown in one click, perfect for notes and READMEs.',
    features: ['Copy current page as [title](url)', 'Copy selected text as a blockquote with source', 'Copy all tabs in the window as a list', 'Context-menu entries', 'Strip tracking parameters from URLs', 'Choose formats in options'],
    goal: N('Build a Manifest V3 extension in TypeScript with a popup and context-menu items. Actions: copy the current page as a markdown link, copy the current selection as a blockquote followed by a source link, and copy every tab in the current window as a markdown bullet list. URLs are cleaned of `utm_*`, `fbclid` and `gclid` parameters, titles have brackets escaped, and the copying uses an offscreen document or the active tab for clipboard access as Manifest V3 requires. Options let the user choose list style and whether to include the site name. Acceptance: the formatting and URL cleaning functions are pure and tested with awkward titles and URLs, and the build outputs a loadable folder with load steps in the README.'),
    tags: ['extension', 'markdown', 'clipboard', 'notes'],
  },

  // ---- Developer tools ----
  {
    id: 'dotenv-doctor', title: 'Dotenv doctor', category: dev, level: 'starter', hours: '1-2', stack: 'Node, TypeScript',
    pitch: 'Checks that your .env, .env.example and the variables your code reads all agree, before a missing variable breaks production.',
    features: ['Finds process.env.X and os.environ usage in code', 'Compares with .env.example', 'Lists missing, unused and undocumented variables', 'Warns when .env is not git-ignored', 'CI mode with exit code', 'Never prints variable values'],
    goal: N('Build `envdoctor`, a CLI with Node and TypeScript. It scans a project (skipping `node_modules`, `.git`, `dist`) for environment variable reads such as `process.env.NAME`, `process.env["NAME"]`, `import.meta.env.NAME`, `os.environ["NAME"]`, `os.getenv("NAME")` and `ENV["NAME"]`, parses `.env` and `.env.example` with correct handling of comments and quotes, and reports: variables used in code but missing from `.env.example`, variables in `.env.example` that nothing uses, and variables set in `.env` but not documented. It also warns when `.env` exists but `.gitignore` does not cover it. The tool never prints values, only names. `--ci` exits non-zero on problems and `--json` prints a machine report. Acceptance: tests with fixture projects cover each finding and the no-values guarantee.'),
    tags: ['env', 'cli', 'security', 'ci'],
  },
  {
    id: 'api-mock-server', title: 'Mock API server from a file', category: dev, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript, Express',
    pitch: 'Describe endpoints in a file and get a working fake API with delays, errors and persistent data, so the frontend never waits for the backend.',
    features: ['Routes from a YAML or JSON file', 'Dynamic path parameters in responses', 'Simulated latency and random failures', 'CRUD collections persisted to a JSON file', 'Request log page', 'CORS enabled by default'],
    goal: N('Build `mockapi`, a CLI with Node, TypeScript and Express. `mockapi serve api.yaml` reads route definitions: method, path with parameters, status, headers, a response body that can interpolate `{{params.id}}`, `{{query.q}}` and generated values like `{{uuid}}`, plus optional `delayMs` and `failRate`. A `collections` section declares resources such as `todos` and generates full CRUD routes with ids, filtering by query string, pagination and persistence to a JSON file. A `/__log` page lists the last 200 requests with timing, and CORS is on by default. The server reloads when the spec file changes, and invalid specs fail fast with line-aware errors. Acceptance: tests use supertest to cover interpolation, CRUD, delay and failure rates with a seeded random source, and spec validation.'),
    tags: ['api', 'mock', 'express', 'frontend'],
  },
  {
    id: 'webhook-inspector', title: 'Webhook inspector', category: dev, level: 'intermediate', hours: '2-4', stack: 'Node, Express, Server-Sent Events, SQLite',
    pitch: 'Get a URL that records every request sent to it and shows headers and body live, so you can debug webhooks without guessing.',
    features: ['Create endpoints with a random id', 'Live feed of incoming requests', 'Pretty JSON, form and raw body views', 'Replay a request to another URL', 'Copy as curl', 'Auto-delete after 24 hours'],
    goal: N('Build a webhook inspector with Node, Express, SQLite and Server-Sent Events. `POST /api/endpoints` creates an endpoint with an unguessable id; any method to `/hook/:id` is recorded (method, path, query, headers, body up to 1 MB, time, source IP) and returns 200 or a configurable status and body. The UI at `/e/:id` lists requests live as they arrive, shows JSON pretty-printed, form data as a table and anything else raw, lets the user copy a request as a `curl` command, and replay it to a URL they enter (blocking private and loopback targets to avoid SSRF). Requests and endpoints older than 24 hours are deleted. Acceptance: tests cover recording of different content types, the SSRF guard on the replay target, size limits and expiry.'),
    tags: ['webhooks', 'debugging', 'sse', 'express'],
  },
  {
    id: 'readme-generator', title: 'README generator', category: dev, level: 'starter', hours: '1-3', stack: 'Node, TypeScript',
    pitch: 'Scan a project and write a solid README skeleton with install, run and test commands filled in from what it finds.',
    features: ['Detects language, framework and scripts', 'Installs and run commands from package.json or manifests', 'Project tree of important folders', 'Environment variable table from .env.example', 'Badges for license and node version', 'Never overwrites an existing README without --force'],
    goal: N('Build `readmegen`, a CLI with Node and TypeScript and no network or AI. It inspects a folder: detects Node, Python, Rust or Go from manifests; reads `package.json` name, description, scripts and engines; finds a license file; lists `.env.example` variables in a table with their comments; and prints a shallow tree of the main folders. It writes `README.md` with sections for Overview, Requirements, Install, Run, Test, Configuration, Project layout and License, using the real commands it found (for example `npm run dev`) and omitting sections with no data. It refuses to overwrite an existing README unless `--force` is passed, and `--stdout` prints instead. Acceptance: tests on fixture projects for each ecosystem check the generated commands and the refusal to overwrite.'),
    tags: ['docs', 'cli', 'scaffolding', 'readme'],
  },
  {
    id: 'project-scaffolder', title: 'Project starter CLI', category: dev, level: 'intermediate', hours: '3-5', stack: 'Node, TypeScript',
    pitch: 'Create your own `create-app` command that sets up a new project from templates with tests, lint and CI already wired.',
    features: ['Interactive prompts or flags', 'Templates: Express API, Vite frontend, Telegram bot, CLI tool', 'Placeholders replaced in files and names', 'Git init and first commit option', 'Install step with the package manager you choose', 'Templates stored as plain folders'],
    goal: N('Build a project scaffolding CLI named `mkapp` with Node and TypeScript. Templates live as plain folders under `templates/` (express-api, vite-app, telegram-bot, node-cli), each with a working `npm test`, ESLint config, `.gitignore`, a GitHub Actions workflow and a README with `{{name}}` and `{{description}}` placeholders. `mkapp new my-app --template telegram-bot` (or interactive prompts) copies the template into a new folder, replaces placeholders in file contents and file names, refuses non-empty target folders, and optionally runs `git init` plus a first commit and the install command for npm, pnpm or yarn. `mkapp list` shows templates with descriptions from each template\'s `template.json`. Acceptance: tests generate every template into a temp folder and verify files and replaced placeholders, and the generated projects\' tests pass in the README\'s documented check.'),
    tags: ['scaffolding', 'templates', 'cli', 'productivity'],
  },

  // ---- Business and money tools ----
  {
    id: 'appointment-booking', title: 'Appointment booking page', category: biz, level: 'intermediate', hours: '3-6', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'A page where customers pick a service and a free slot to book, and the owner manages the day, good for salons, tutors and clinics.',
    features: ['Services with duration and price', 'Weekly working hours and days off', 'Customers see only free slots', 'Booking confirmation with a cancel link', 'Admin calendar for the day and week', 'Reminder message text for WhatsApp'],
    goal: N('Build an appointment booking app with Node, Express and SQLite. The owner defines services (name, duration, price), weekly opening hours and blocked dates in an admin area protected by a password. The public page shows services, then a date picker and the free slots computed from opening hours minus existing bookings in the Asia/Kolkata time zone, with a buffer between appointments. Booking takes a name and phone number, prevents double booking with a database constraint even under concurrent requests, and shows a confirmation page with a private cancel link. The admin view lists today and the week and offers a prefilled `wa.me` link with a reminder message per booking. Acceptance: slot generation is a pure tested function covering overlaps, buffers and days off, and a concurrency test proves one slot cannot be booked twice.'),
    tags: ['booking', 'business', 'calendar', 'sqlite'],
  },
  {
    id: 'invoice-generator', title: 'Invoice generator with GST', category: biz, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite, PDFKit',
    pitch: 'Create professional invoices with correct GST maths, numbering and a PDF download, for freelancers and small shops.',
    features: ['Clients and items saved for reuse', 'Sequential invoice numbers per financial year', 'CGST and SGST or IGST by state', 'PDF with logo, amount in words', 'Paid and unpaid status', 'Monthly sales summary'],
    goal: N('Build an invoice app with Node, Express, SQLite and PDFKit. The user saves business details (name, address, GSTIN, state) and clients, then creates an invoice with line items (description, HSN or SAC, quantity, rate, GST rate). Numbering is sequential per financial year starting April, like `2026-27/0001`. If the client\'s state equals the business state the tax splits into CGST and SGST, otherwise it is IGST. Totals use integer paise with round-half-up per line and the grand total is shown in words in Indian numbering. Download a clean PDF, mark invoices paid or unpaid, and see a monthly summary of sales and tax collected. Acceptance: tax splitting, rounding, numbering across the April boundary and amount-in-words are pure functions with extensive tests.'),
    tags: ['invoice', 'gst', 'pdf', 'india'],
  },
  {
    id: 'inventory-tracker', title: 'Inventory tracker for a small shop', category: biz, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'Know what is in stock, get warned before it runs out and see which items sell, without a spreadsheet.',
    features: ['Products with SKU, barcode, cost and price', 'Stock in and out with reasons', 'Low-stock alerts with reorder levels', 'Barcode scan using a USB scanner as keyboard', 'CSV import and export', 'Profit and best-seller report'],
    goal: N('Build an inventory tracker with Node, Express and SQLite. Products have a SKU, name, optional barcode, cost price, selling price and reorder level; every change goes through an append-only stock movements table (purchase, sale, adjustment, with a reason and time) and current stock is the sum, so history is never lost. A sale screen accepts barcode input (a scanner types the code and presses Enter), builds a bill and records the movements atomically, refusing to go below zero. A dashboard lists low-stock items, today\'s sales and profit, and best sellers for the last 30 days. CSV import creates or updates products and export downloads products and movements. Acceptance: stock calculation and atomic sale recording are tested, and a failed sale leaves stock unchanged.'),
    tags: ['inventory', 'shop', 'barcode', 'sqlite'],
  },
  {
    id: 'mini-storefront', title: 'Mini storefront with UPI checkout', category: biz, level: 'ambitious', hours: '5-8', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'A small online shop with products, a cart and a UPI payment QR, plus an order dashboard, with no payment provider fees.',
    features: ['Product catalogue with images and categories', 'Cart that survives page reloads', 'Checkout with address and phone', 'UPI QR and deep link with the exact amount and order id', 'Owner marks payment received and order shipped', 'Order status page for customers'],
    goal: N('Build a mini storefront with Node, Express and SQLite. The catalogue shows products with images, price and stock, filtered by category and search; the cart lives in localStorage and is re-priced on the server at checkout so prices cannot be tampered with. Checkout collects name, phone and address, creates an order with a unique id and shows a `upi://pay` deep link and an SVG QR carrying the exact amount and the order id as note. The admin area, protected by a password, lists orders by status (awaiting payment, paid, shipped, cancelled), lets the owner mark payment received and shipped, edits products and adjusts stock, which is decremented only when an order is marked paid. Customers check status at a private order link. Acceptance: server-side pricing, stock handling and order state transitions are tested, and uploads are limited to images.'),
    tags: ['ecommerce', 'upi', 'shop', 'orders'],
  },
  {
    id: 'khata-ledger', title: 'Khata: shop credit ledger', category: biz, level: 'intermediate', hours: '3-5', stack: 'Node, Express, SQLite, vanilla JS',
    pitch: 'A digital udhaar notebook for a local shop: who owes what, payments received and a polite reminder message in one tap.',
    features: ['Customers with phone numbers', 'Add credit given and payments received', 'Running balance per customer and total outstanding', 'WhatsApp reminder link with a prefilled message', 'Statement per customer as a printable page', 'Daily backup of the database file'],
    goal: N('Build a khata ledger app with Node, Express and SQLite for a small shop. Customers have a name and phone number, and every entry is either credit given or payment received with an amount in integer paise, a note and a date; balances are always computed from entries. The home page lists customers sorted by amount owed with the total outstanding, search by name or phone, and a quick-add form. Each customer page shows a statement with running balance, a button that opens a prefilled `wa.me` link such as "Namaste Ravi, your pending balance is ₹1,250", and a print stylesheet for a one-page statement. Protect the app with a single owner PIN and copy the database to a dated backup file once a day. Acceptance: balance maths, statement ordering and the PIN gate are tested.'),
    tags: ['ledger', 'shop', 'india', 'whatsapp'],
  },
  {
    id: 'subscription-tracker', title: 'Subscription and renewal tracker', category: biz, level: 'starter', hours: '1-3', stack: 'Vite, TypeScript, localStorage',
    pitch: 'List every subscription and renewal, see what they cost per month and year and get warned a few days before each charge.',
    features: ['Name, price, billing cycle and next date', 'Monthly and yearly totals', 'Upcoming charges in the next 30 days', 'Mark as cancelled and track savings', 'Categories and a spend chart', 'Reminder banner and calendar export'],
    goal: N('Build a subscription tracker as a single-page app with Vite and TypeScript, saved in localStorage. Each item has a name, price in rupees, billing cycle (weekly, monthly, quarterly, yearly), next renewal date, category and optional notes. The dashboard shows the total per month and per year normalised across cycles, a list of charges due in the next 30 days with a warning banner for those within 3 days, a category breakdown chart in SVG, and cancelled items with the money saved per year. Renewal dates roll forward correctly after they pass, including month ends such as 31 January to 28 February. Export upcoming renewals as an `.ics` file. Acceptance: the roll-forward and normalisation functions are pure and tested around month ends and leap years.'),
    tags: ['money', 'subscriptions', 'reminders', 'calendar'],
  },
]

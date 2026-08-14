# LoL Bench Bot

A Discord bot for a 6-player League of Legends rotation. After each game, it pulls the
match from Riot's API and scores every tracked player who played, so the "who gets
benched" decision is based on data instead of whoever gets blamed loudest in voice chat.

## How the scoring works

Every player is graded on **what their role is actually supposed to do**, against the
player on the other team who had the identical job. One number, 0–100, and it means the
same thing for all five roles:

> **50 = you did your job.** Above 50 you beat the player opposite you at it, below 50 you
> lost that matchup.

That shared anchor is what makes the scores comparable across roles. A jungler's 62 and an
ADC's 62 both mean "beat their counterpart by a similar margin", so `/worst` can compare
them honestly.

### Per-role rubrics

| | Top | Jungle | Mid | ADC | Support |
|---|---|---|---|---|---|
| Lane @14 (gold + xp vs counterpart) | 25 | — | 24 | 18 | 12 |
| Side pressure (plates, turret dmg, solo kills) | 15 | — | — | — | — |
| Teamfight / damage | 22 | 12 | 24 | 28 | — |
| Death discipline | 20 | 8 | 16 | 20 | 12 |
| Objectives | 10 | 24 | 8 | 12 | 8 |
| Map presence / roam | 8 | — | 18 | 6 | 18 |
| Lanes @14 (state of the map you shaped) | — | 20 | — | — | — |
| Gank impact & counter-response | — | 14 | — | — | — |
| Jungle economy & counter-jungling | — | 12 | — | — | — |
| Vision | — | 10 | (in tempo) | — | 28 |
| Farm & gold | — | — | 10 | 16 | — |
| Engage & peel (CC, heal/shield, saves) | — | — | — | — | 22 |

The composite of those weights **is** the score — nothing is blended in on top of it.

### Why it's built this way

**A low-impact jungler has nowhere to hide.** Deaths are the *lightest* weight in the
jungle rubric (8%) and objective control plus the state of the three lanes at 14 minutes
are the heaviest (44% combined). A jungler who farms safely to 3/2/9, contests nothing and
lets every lane fall behind gets graded on exactly that. Under the old model that same
game scored *well*, because low deaths were 35% of the composite for everyone.

**A camped laner isn't punished for someone else's macro.** The bot reads the timeline for
enemy-jungler commitments into each lane before 15 minutes — landed ganks, plus frames
where the enemy jungler is standing next to you while your lane opponent is there too.
Net pressure then:

- shifts the lane grade's break-even point (roughly −380 gold per net commitment, capped
  at three) so you're measured against the deficit you were *expected* to be at;
- discounts ganked deaths to 0.7× weight;
- nudges side pressure, CS and gold comparisons by up to ±12 points, because a laner who
  is dived every wave can't take plates either;
- **credits the enemy jungler** who created the pressure, and **debits your own jungler**
  for every commitment they left unanswered.

**Deaths are weighted by whose fault they were.** A 1v1 death counts 1.25×, a 3-man
collapse 0.75×, a death inside a teamfight 0.55×. Traded deaths, deaths alone in enemy
territory, shutdowns given up and late-game deaths all adjust further, and the result is
compared to your counterpart's context-weighted deaths — not to a raw per-minute rate.

**No metric asks a role to do another role's job.** Support vision is compared to the
enemy support's, not to an ADC's. The old damage-per-gold metric quietly punished every
support who bought support items.

Every component also falls back to a role baseline (rough SR averages), so a lane where
both players played badly doesn't hand one of them a good score for being marginally less
bad.

### Rolling average

Each match produces an **objective composite (0–100)** per player. The bot tracks a
**rolling average** over each player's last N games (default 10, set via `ROLLING_WINDOW`)
so one bad game doesn't bench someone who's normally solid.

`/worst` and `/leaderboard` use the rolling average, not a single game, to make the actual
bench call.

## Setup

1. **Discord bot**
   - Go to https://discord.com/developers/applications → New Application
   - Bot tab → Reset Token → copy it → `DISCORD_TOKEN`
   - General Information tab → Application ID → `DISCORD_CLIENT_ID`
   - OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → permissions:
     `Send Messages`, `Embed Links` → open the generated URL to invite it to your server
   - (Optional but recommended while testing) right-click your server in Discord with
     Developer Mode on → Copy Server ID → `DISCORD_GUILD_ID` (guild-scoped commands
     update instantly; global commands can take up to an hour to propagate)

2. **Riot API key**
   - https://developer.riotgames.com/ → generate a development key (expires every 24h —
     fine for testing, apply for a personal/production key for long-term use)
   - `RIOT_API_KEY`
   - Set `RIOT_REGION` (americas / asia / europe — routing for match/account lookups) and
     `RIOT_PLATFORM` (your actual server shard, e.g. euw1, na1, kr, eun1)

3. **Install & configure**
   ```bash
   npm install
   cp .env.example .env
   # fill in .env with the values above
   ```

4. **Register slash commands, then start the bot**
   ```bash
   npm run deploy-commands
   npm start
   ```

## Commands

- `/register game_name:<name> tag_line:<tag>` — link your Discord account to your Riot ID
  (e.g. `/register game_name:Faker tag_line:KR1`). Run once per player, all 6 people.
- `/roster` — list everyone currently registered.
- `/fetchgame` — score **every** new match your squad has played together (up to 5 per
  run; use `count:` to score fewer). You normally won't need this — the watcher posts
  games automatically. One card per player, best to worst, three across:

  ```
  🌲 Jungle · F 🔻
  @ILoveKebab911 — Ivern
  ▰▰▰▱▱▱▱▱▱▱ 28.6
  KDA 4/7/10 · +293g @14
  Weakest: Gank impact 0
  ```

  `Weakest` is the role component that cost that player the most, so each card says
  *why* the score is what it is. Below the cards:

  - **🪑 Bench watch** — the worst player's three weakest components and every flag
    against them, so the bench call comes with its reasoning attached.
  - **📌 Worth knowing** — flags for everyone else, and only when there is one:
    camped, left unanswered, solo deaths. A clean game shows no section at all.
  - **⚔️ Enemy team** — one line, enough to tell whether the lobby was one-sided.
- `/fetchgame detail:true` — same match, but every player's full per-role breakdown
  with the raw stat behind each component (`28.0 Lane 25% · -1600g @14 (bar -1140g)`).
  Use it when someone disputes a bench call.
- `/profile player:<@user>` — one player's full record: overall average and squad rank,
  a bar per role, form trend, a sparkline of recent games, best and worst single game,
  and most-played champions. `/alltime` is the squad view; this is the individual one.
- `/leaderboard` — rolling average score per player over the last `ROLLING_WINDOW`
  games, best to worst. This is recent form, and it's what `/worst` benches on.
- `/alltime` — career standings across **every** game ever scored. Per player:
  overall average, games, win rate, best and worst single game, how many times
  they finished bottom, whether recent form is above or below their own average,
  and a **per-role average** (`⚡ Mid 67.0 ×6 · 🌲 Jungle 46.8 ×4`). Because scores
  are role-anchored, those role averages are directly comparable — so the embed
  also names the squad's **best player in each role**, which is the number a
  rotation actually needs when deciding who plays what.
- `/worst` — who the data says should be benched right now.
- `/history player:<@user> count:<n>` — a player's recent scored games.

## Which games get scored

Standard 5v5 Summoner's Rift only:

| Scored | Not scored |
|---|---|
| Ranked Solo/Duo (420), Ranked Flex (440) | ARAM (450), Arena (1700/1710) |
| Normal Draft (400), Normal Blind (430) | URF, ARURF, One for All, Nexus Blitz, Ultimate Spellbook |
| Quickplay (490), Clash (700) | Co-op vs AI, Custom games |

The rubrics assume Summoner's Rift: five distinct roles, a lane opponent playing the
same role on the other team, a jungle, and objectives on a known timer. ARAM has none
of that, and Arena is 2v2v2v2. Scoring them produces confident-looking nonsense — every
player "Weakest: Economy 0", nine champions listed under "Enemy team" — so they're
rejected before reaching the scorer, and remembered as rejected so they're never
re-fetched.

A game also has to have been played **on the same team**. Registered players split
across both sides isn't a squad game: teammates would be listed as enemies and the
bench call would compare across the two teams.

Override the list with `ALLOWED_QUEUES` if you want something else — e.g.
`ALLOWED_QUEUES=420,440` for ranked only, or add `480` if you play Swiftplay (excluded
by default because its accelerated economy skews the gold-at-14 baselines).

Games from unsupported queues that were scored before this filter existed are removed
automatically on the next startup, and the count is logged.

## Auto-posting finished games

Set `DISCORD_WATCH_CHANNEL_ID` and the bot posts each game's scorecard by itself,
usually within a minute of the game ending. Leave it unset and `/fetchgame` stays
manual.

Riot has no webhooks and no push of any kind, so the only way to learn a game finished
is to ask. The watcher asks a cheap question often rather than an expensive one rarely:
the spectator endpoint says whether anyone is in a game *right now*, which turns
"poll match history and hope" into three states:

| State | When | What it does |
|---|---|---|
| **Idle** | nobody in a game | spectator check every `WATCH_IDLE_INTERVAL` (180s), plus a full scan every `WATCH_SAFETY_INTERVAL` (1800s) to catch games played while the bot was down |
| **Live** | someone is in a game | spectator check every `WATCH_LIVE_INTERVAL` (120s). Doesn't touch match history — the result isn't published yet |
| **Settling** | a game just ended | scans every `WATCH_SETTLE_INTERVAL` (45s) until the match appears, giving up after ~6 minutes |

Defaults are tuned for a Riot **development** key (100 requests per 2 minutes). With a
production key you can poll considerably harder.

## Registering slash commands

The bot registers its commands on startup, so adding or changing one only needs a
deploy. The payload is hashed, so a restart that changed nothing doesn't call Discord
at all. `npm run deploy-commands` still exists to force a re-register without
restarting.

## Tests

```bash
npm test
```

No test framework or extra dependencies — `node --test` with synthetic matches under
`test/helpers/`. The scoring model is a pile of judgement calls (component weights,
jungle-pressure caps, death multipliers), so the suite pins the behaviour those calls
were made for: a low-impact jungler scores badly despite a good KDA, a camped laner
isn't punished for it, and the skip cache never re-fetches a match it already rejected.

## Data storage

Everything is stored in `data/db.json` (created automatically on first run) — no
database server needed. Back it up or inspect it directly if you want; it's just JSON.

Set `DATA_DIR` to put it somewhere else. On a host with an ephemeral filesystem
(Railway, Fly, most container platforms) the repo directory is wiped on every
deploy, which would reset every registered player and every scored game — and
`/alltime` is only as good as the history behind it. Mount a persistent volume and
point `DATA_DIR` at it:

```bash
DATA_DIR=/data
```

## Notes / known limitations

- `/fetchgame` calls the **timeline** endpoint (`/lol/match/v5/matches/{id}/timeline`) for
  the one match it scores. That's where lane state at 14, jungle pressure, death context
  and objective control come from. If the call fails, the score is still produced — those
  components drop out and the embed says so — but it's a much blunter grade, so a rate
  limit or an expired key shows up as `⚠️ Timeline unavailable`.
- Lane assignment for gank detection splits the map on the mid diagonal, so a fight in the
  river or the enemy tri-brush is attributed to the nearest lane. Frame snapshots are 60
  seconds apart and miss short ganks entirely, which is why landed ganks (kill events)
  count for more than proximity frames and why proximity is capped.
- A match where Riot's role detection fails falls back to a role-neutral rubric and is
  labelled as such.
- Scores stored before this rewrite used the old lobby-relative model and aren't
  comparable. Run `/resetgames` if you want a clean rolling average.
- A match with fewer than 2 tracked players is remembered as rejected, so every solo
  queue game in the lookback window is checked exactly once rather than re-fetched on
  every scan. That cache is invalidated whenever someone new registers, since a bigger
  roster can change the verdict.
- Scoring only includes players who actually appear in that match — the 6th player
  sitting out a given game simply isn't scored for it, which is correct (they can't be
  "worst" in a game they didn't play).

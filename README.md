# LoL Bench Bot

A Discord bot for a 6-player League of Legends rotation. After each game, it pulls the
match from Riot's API and scores every tracked player who played, so the "who gets
benched" decision is based on data instead of whoever gets blamed loudest in voice chat.

## How the scoring works

Comparing raw stats across roles doesn't work — a support's damage and an ADC's damage
aren't the same thing. So instead of fixed thresholds, each player is scored **relative
to the other tracked players who played in that specific match**, using role-neutral
ratios:

| Metric | Weight | Why |
|---|---|---|
| Kill participation % | 20% | Were they even near the fights that mattered |
| Damage / gold efficiency | 25% | Filters out "farmed but did nothing" |
| Vision + objective involvement | 20% | Vision score/min + turret/dragon/baron takedowns |
| Deaths per minute (inverted) | 20% | Fewer deaths = higher score |
| Teammate impact vote (`/vote`, optional) | 15% | Stats can't see "threw the fight" or "made the game-winning call" |

Each match produces an **objective composite (0–100)** per player. The bot then tracks a
**rolling average** over each player's last N games (default 10, set via `ROLLING_WINDOW`)
so one bad game doesn't unfairly bench someone who's normally solid — this also protects
against blaming whoever died last, which tends to dominate in-person votes.

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
- `/fetchgame` — pull the most recent shared match and score everyone who played.
  Run this after each game.
- `/vote player:<@user> rating:<1-5>` — rate a teammate's impact on the most recently
  scored game. Optional, but fills in what stats can't see.
- `/leaderboard` — rolling average score per player, best to worst.
- `/worst` — who the data says should be benched right now.
- `/history player:<@user> count:<n>` — a player's recent scored games.

## Data storage

Everything is stored in `data/db.json` (created automatically on first run) — no
database server needed. Back it up or inspect it directly if you want; it's just JSON.

## Notes / known limitations

- Riot's match API doesn't expose "which death directly gave up an objective" without
  parsing the full match **timeline** (a separate, heavier endpoint). The current
  "deaths per minute" metric is a reasonable proxy but not a perfect substitute — if you
  want that level of detail later, the timeline endpoint (`/lol/match/v5/matches/{id}/timeline`)
  is the next thing to integrate.
- `/fetchgame` finds a match by searching one registered player's recent history for a
  game that at least 2 tracked players share. If your squad plays multiple games in a
  session, run `/fetchgame` after each one (it skips matches already scored).
- Scoring only includes players who actually appear in that match — the 6th player
  sitting out a given game simply isn't scored for it, which is correct (they can't be
  "worst" in a game they didn't play).

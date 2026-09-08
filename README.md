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
| Teamfight / damage | 22 | 22 | 24 | 28 | — |
| Death discipline | 20 | 9 | 16 | 20 | 12 |
| Objectives | 10 | 20 | 8 | 12 | 8 |
| Map presence / roam | 8 | — | 18 | 6 | 22 |
| Gank impact & counter-response | — | 16* | — | — | — |
| Tempo & map control | — | 16 | — | — | — |
| Jungle farm (own camps) | — | 7 | — | — | — |
| Vision | — | 10 | (in tempo) | — | 24 |
| Farm & gold | — | — | 10 | 16 | — |
| Engage & peel (CC, heal/shield, saves) | — | — | — | — | 22 |

The composite of those weights **is** the score — nothing is blended in on top of it.
`*` scales with game length; see *laning-phase weights* below.

### Why it's built this way

**A low-impact jungler has nowhere to hide.** Deaths are the *lightest* weight in the
jungle rubric (9%) and objective control, gank impact and tempo are the heaviest (52%
combined). A jungler who farms safely to 3/2/9, contests nothing and lets every lane fall
behind gets graded on exactly that. Under the old model that same game scored *well*,
because low deaths were 35% of the composite for everyone.

**But a high-impact jungler has to be able to score, too.** Taken too far, the point above
produces the opposite failure. Jungle used to be the only non-support role where fighting
was a *minority* of the grade — 24%, against 46% for top, 43% for mid and 51% for the ADC —
so an identical dominant fighting game moved a jungler's composite by 1.4 points where it
moved a mid laner's by 3.4. Teamfight is now 22, putting jungle at 33% fighting and 67%
macro: still the most macro-weighted role of the four, no longer an outlier.

That's safe to do because of what Teamfight is made of. It isn't a damage number — it's
damage share, kill share, *and* post-15 kill participation, and the farming-jungler fixture
moves only from 30.0 to 30.5 under the reweight. A jungler who contests nothing scores
badly on Teamfight too, and post-15 participation is the half of it they cannot fake.

**A jungler is graded on the map they were actually on.** *Tempo & map control* replaced a
flat "how were my four lanes doing at 14 minutes", which was the only component in any
rubric where the score was set almost entirely by other people — and symmetric with the
enemy jungler, so a laner running it down handed the *other* jungler credit for it. The
three parts are decisions only the jungler makes:

- **Cross-map trades (40%)** — when both teams take something on opposite sides of the map
  inside 45 seconds, that's a trade. Graded on value won against value given up (a baron
  for a drake is a win, the reverse isn't), using the same weights objective control uses.
  Two drakes isn't a trade, it's a contest; six minutes apart isn't a trade, it's two
  plays. No trades on the board and the part drops out rather than resolving to a neutral
  50 — a game where nobody traded says nothing about whether you trade well.
- **Control of the enemy jungle (30%)** — moved here out of Jungle farm, where it was a
  quarter of a 12-point component and amounted to about 3% of the grade. Taking the
  enemy's camps is a tempo act, not a farming one, and Jungle farm is now purely "did you
  clear your own jungle as fast as they cleared theirs".

  Camps alone read *backwards*: a jungler who cleared 24 of your camps and died five times
  doing it scored as winning the enemy jungle, while the jungler who killed them there
  scored as losing it, because kills are not camps. The figure is now netted, priced in
  camps so it stays on the scale the comparison was tuned for:

  ```
  enemy camps taken  +  3 × takedowns on their jungler  −  2 × your deaths in their half
  ```

  Dying costs less than a takedown earns because the Deaths component already charges for
  it, and charging full price twice punishes one event two ways. Jungler-on-jungler
  takedowns are counted for the whole game, not just laning: `gankTakedowns` stops at 15
  minutes and skips jungler victims entirely — correctly, since a jungler killing the
  enemy jungler is not a gank on a lane — but that left the fight over their raptors at 24
  minutes counted nowhere at all.
- **Presence-weighted lane state (30%)** — the honest half of the old component. Each
  lane's gold swing at 14, weighted by how much of laning you spent in it. Camp a lane to
  a win and it's yours; a lane that won without you is only partly yours. A jungler who
  was everywhere equally, or nowhere at all, gets the flat average — exactly what the old
  component always did.

  The weights are capped between 1× and 3× deliberately. Riot samples position once a
  minute, so presence is about fourteen dots per game: enough to say "mostly top", never
  enough to fully credit or fully absolve a jungler for one lane.

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

**Dragon Soul is weighted as the game-deciding objective it is.** Objectives are valued
rather than counted — a void grub is worth about a third of a drake, Baron 1.5, Elder 2 —
but the fourth drake counted exactly the same as the first, so a team that took Soul and a
team that took four drakes across two failed soul races scored identically. The
soul-securing dragon now carries a bonus on top of its own weight, making it the single
biggest objective on the board: more than Baron, more than Elder. Elder never counts
toward it, since Elder only spawns once a soul is already taken. The card says `· soul`
or `· conceded soul`.

Two related corrections came with it. A player's personal share is scaled alongside the
bonus, so taking Soul can't *shrink* your share of a team total that grew underneath you.
And Riot's `dragonTakedowns` challenge counts an Elder as just another dragon, so a
personal tally valued Elder at 1 while the team tally valued it at 2 — anyone who took
Elder had their objective share understated for it.

**Every component is anchored to a role baseline, not only to your counterpart.** Farm
comparisons were the last ones graded purely head-to-head, which made them a verdict on
who the *other* team picked: a good jungle clear scored badly against a Karthus, and an
Ezreal on 6.7 cs/min scored 34 opposite a Jinx on 10.7 for a number only a little under
par — the identical game opposite a Draven would have scored well. Jungle farm, ADC
farming and mid wave control now all blend the counterpart comparison with the role
baseline, the way deaths, vision, objectives and damage already did. Out-farming your
opposite number still counts; champion select no longer decides the component on its own.

**This is also a note on how these get fixed.** Jungle farm was corrected on its own
first, leaving the other two broken in exactly the same way for exactly the same reason.
A test now walks the source for cs comparisons that aren't inside a blend, so the next one
can't be missed.

Also: jungle CS is **monsters, not camps** — Riot's own field is `enemyJungleMonsterKills`,
and a full six-camp clear is about eighteen of them. The card used to say "100 camps @14",
which made an ordinary five-clear game read as absurd. It now says `100 jg cs @14`.

**Kill share corrects damage share, for the roles where damage share lies.** Damage share
misses conversion from both directions: an assassin turns less total damage into more
kills, and a mage chipping a whole teamfight racks up damage that killed nobody. Jungle
felt it worst, being the only rubric with no participation component at all — a jungler on
40% of their team's kills was invisible outside a damage number that understated them.

Kill share now sits *inside* the Teamfight/Damage component rather than beside it, so it
can never be a route to a good score on its own: taking every kill on the team while doing
no damage still grades badly. Jungle leans on it hardest, mid gets it lighter (Roaming
already measures participation there), and top and ADC not at all — top counts solo kills
under Side lane, and the ADC has Presence plus 28% on damage. The five roles'
baselines sum to exactly 1, because a share of one team's kills is what it is.

**Deaths are weighted by whose fault they were.** A 1v1 death counts 1.25×, a 3-man
collapse 0.75×, a death inside a teamfight 0.55×. Traded deaths, deaths alone in enemy
territory, shutdowns given up and late-game deaths all adjust further, and the result is
compared to your counterpart's context-weighted deaths — not to a raw per-minute rate.

**No metric asks a role to do another role's job.** Support vision is compared to the
enemy support's, not to an ADC's. The old damage-per-gold metric quietly punished every
support who bought support items.

**Scaling champions aren't graded as if minute 14 decided the game.** Two corrections:

- **Laning-phase weights scale with game length.** Laning is most of a 22-minute game and
  a prelude to a 40-minute one, so anything measured only during it shrinks as the game
  runs long (reference point 27 minutes, clamped to 0.5×–1.2×). Everything else — damage,
  teamfights, objectives — takes up the slack automatically.

  This applies to each laner's **Lane** and to the jungler's **Gank impact**, which is
  built entirely from the first fifteen minutes: gank takedowns, lane visits and
  unanswered pressure all stop at that mark. Leaving it flat graded 18% of a 47-minute
  game on 15 minutes of it while every laner's equivalent metric had already shrunk to
  0.57× — the same window under two different rules. It now runs from 22 in a short stomp
  down to 9 in a marathon.
- **A comeback is credited, in every role.** Gold earned *after* laning is compared
  against the same counterpart. Losing your matchup and then out-earning them for twenty
  minutes lifts the score by up to 28 points, in proportion to how much of the deficit
  was actually erased. It can never turn a lost lane into a won one. The reverse also
  applies: building a lead and then getting out-earned costs up to 10 — less than a
  comeback earns, because coming back takes play while losing a lead often takes one bad
  fight.

  Each role is measured on whatever its deficit was measured on. A solo laner uses their
  own gold; **bot lane uses the pair's**, so a support isn't credited for their ADC's
  recovery; and the **jungler uses their lanes, presence-weighted** — those lanes being 3k
  down at 14 and level by the end is the same achievement a scaling carry gets credit for,
  it just shows up across the map instead of in one lane.

- **The damage bar moves with the clock.** An ADC with one item does a fraction of the
  damage they do with five, while a bruiser or tank is nearest their peak early and fades.
  Grading both against one fixed damage share marked every ADC down in a short game and
  every top laner up — a verdict on the clock rather than on the player, and it landed on
  the ADC's heaviest component (28%). The expected share now shifts with game length, per
  role, anchored so that a 30-minute game is unchanged. An ADC on 23% of their team's
  damage in a 20-minute game now scores the same as one on 31% in a 40-minute game,
  because those are the same performance.

  The slopes are deliberately conservative. They estimate a real effect, and
  under-correcting leaves a small residual bias where over-correcting would invent the
  opposite one and start rewarding ADCs for short games.

**Roaming off a won lane is credited, not punished.** A takedown away from your own
lane during laning phase counts as a roam, and for supports it's part of the
Participation grade alongside raw kill participation. Leaving a bot lane you've already
won is the job, not a dereliction of it.

**Kill participation is graded against how the game spread its kills.** KP is a share of
your own team's kills, so a 38-kill rout of solo picks compresses everyone's number —
the highest on the team can sit below a role baseline calibrated for a normal game.
The baseline is rescaled by the team's average participation, so it rises in
teamfight-heavy games and falls in pick-heavy ones.

**Jungle pressure is trusted asymmetrically.** Pressure *against* you is corroborated by
deaths — the enemy jungler is in the kill feed. Pressure *for* you is mostly inferred
from position frames, and "my jungler was standing nearby" is weak evidence they did
anything, especially in bot lane which sits right beside the bot jungle. So proximity
counts fully against and a third as much for, only a kill **in your own lane** counts as
your jungler having helped you, and the bar can be raised by at most 2 commitments
against 3 for lowering. Wrongly excusing a bad lane is a mild error; wrongly
punishing a laner for their jungler's pathing is not.

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
- `/fetchgame` — score the **most recent** unscored match your squad played together.
  `count:` (max 5) scores further games behind it, newest first, each as its own
  message. You normally won't need this — the watcher posts games automatically. One
  card per player, best to worst, three across:

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
- `/match` — re-open a game that was **already** scored, with the full breakdown.
  Defaults to the most recent; the `game:` option autocompletes a picker of your
  history (`W · 14/08/2026 · 33min · riaN Ahri, kaiz Nunu`). `summary:true` gives the
  short scorecard instead. Costs no Riot API calls — the full per-role breakdown is
  stored with every game, so this works on any game in your history however old.
- `/profile player:<@user>` — one player's full record: overall average and squad rank,
  a bar per role, form trend, a sparkline of recent games, best and worst single game,
  and most-played champions. Also a **per-component breakdown** averaged across every
  game — per-role tells you which role suits them, this tells you what they're doing
  wrong inside it. `/alltime` is the squad view; this is the individual one.
- `/leaderboard` — recent form: each player's average over **their own** last
  `ROLLING_WINDOW` games (default 10), best to worst. Someone who sat out three of the
  squad's last ten is still measured across ten of their own, so nobody is judged on a
  shorter record than everyone else. Needs `LEADERBOARD_MIN_GAMES` games (default 5) to
  be ranked; anyone below that is listed separately with their progress toward it.
- `/alltime` — career standings across **every** game ever scored. Per player:
  overall average, games, win rate, best and worst single game, how many times
  they finished bottom, whether recent form is above or below their own average,
  and a **per-role average** (`⚡ Mid 67.0 ×6 · 🌲 Jungle 46.8 ×4`). Because scores
  are role-anchored, those role averages are directly comparable — so the embed
  also names the squad's **best player in each role**, which is the number a
  rotation actually needs when deciding who plays what. Needs `ALLTIME_MIN_GAMES`
  games (default 3) to hold a position; below that a player is listed separately
  with their progress toward it, and isn't eligible for "best in role" either.
- `/alltime period:week` / `period:month` — the same board over the **last 7 or 30
  days** instead of the full record. Rolling windows, not calendar ones, so the board
  is never empty just because it's the 1st. Every number is recomputed inside the
  window — including the squad average that ratings are weighted against — so it
  answers "how are we playing lately", not "here's a slice of the all-time table".
  With no `period`, `/alltime` remains the genuine all-time record.
- `/worst` — who the data says should be benched right now, **and why**. Alongside the
  number it averages each rubric component across the window, so the call comes with the
  reason attached (`Vision 39 · under 45 in 7 of 7 games — that's the pattern, not one
  bad night`) plus what they're doing well. Only considers players who have hit the
  minimum, so a single bad game can't get someone benched, and it says when the call is
  too close between the bottom two to be a real verdict.
- `/benched` — the running tally of who has actually been benched, and which roles get
  benched most. Roles come first: each shows the count *and* the games played in that
  role, because "ADC benched 4 times" means something different across 10 games than
  across 5. Then each player, with the roles they were playing when it happened, so a
  jungler who gets benched only on their off-role reads differently from one who doesn't.

  Roles that were played but never benched still appear on 0 — the denominator is what
  makes the tally mean anything. Optional `period:` for the last 7 or 30 days.

  Unlike the leaderboards this has **no minimum games**: it counts things that happened
  rather than ranking form, so hiding someone benched once because they only have two
  games would hide the exact fact being asked for. Games with only one registered player
  in them are excluded from the denominator — being worst of one is meaningless.
- `/history player:<@user> count:<n>` — a player's recent scored games.
- `/resetgames confirm:RESET` — wipe all scored game history. Keeps registered players.
  **Restricted to the bot owner**; anyone else gets a private refusal and nothing is
  touched, and permission is checked *before* the confirmation word so a stranger learns
  nothing from a wrong guess. Set `ADMIN_USER_IDS` (comma-separated Discord user ids) to
  change who can run it — it defaults to the owner, so no config is needed.

  `duplicates:true` removes only games stored more than once, keeping one copy of each —
  the best-quality copy, then the lowest match id so the choice is stable. The reply names
  what was kept and what was dropped in each group, since this is the one command that
  can't be undone. Games are matched on Riot's numeric `gameId`; rows written before that
  was stored fall back to when the game was played and who played it.

  `last:<n>` clears only the **n most recent** games instead of everything, which is how
  you re-score after a scoring change: clear them, then re-fetch and they come back
  graded by the current rubric. Older games are left alone, and so is the skipped-match
  cache — those were never scored, so re-scoring has no business reconsidering them. The
  reply hands you the exact `/fetchgame` command to run, including how many passes it
  takes, since each pass scores at most 5.

  Two things to know: the watcher may also pick the cleared games up on its next scan and
  re-post them to the watch channel on its own, and `lookback` counts *each player's*
  recent matches, so solo queue played since then can push a squad game out of the window.

## Which games get scored

Standard 5v5 Summoner's Rift only:

| Scored | Not scored |
|---|---|
| Ranked Solo/Duo (420), Ranked Flex (440) | ARAM (450), Arena (1700/1710) |
| Normal Draft (400), Normal Blind (430) | URF, ARURF, One for All, Nexus Blitz, Ultimate Spellbook |
| Quickplay (490), Clash (700) | Co-op vs AI, Custom games |
| **Ranked 5s, and any future Rift queue** | |

The rubrics assume Summoner's Rift: five distinct roles, a lane opponent playing the
same role on the other team, a jungle, and objectives on a known timer. ARAM has none
of that, and Arena is 2v2v2v2. Scoring them produces confident-looking nonsense — every
player "Weakest: Economy 0", nine champions listed under "Enemy team" — so they're
rejected before reaching the scorer, and remembered as rejected so they're never
re-fetched.

**The queue list is a fast path, not the whole rule.** It used to be a hard allowlist
paired with a hard `gameMode === 'CLASSIC'` gate, which meant any queue Riot added after
the list was written got rejected twice over. Ranked 5s is exactly that case: a
weekend-only experimental queue that isn't in Riot's own published `queues.json`, and
that OP.GG only labels "Featured". No allowlist could have known about it.

So a queue that isn't listed is now accepted when it is *structurally* a normal Rift
game — ten real players, five a side, four of five roles readable on both teams, a
matched (non-custom) game, on map 11, in a mode that isn't a known rotating one. Every
condition the allowlist was really standing in for is checked directly. Bot games stay
out despite being Rift CLASSIC (Riot marks them with a `BOT` puuid), and so do customs,
which can be anything at all.

Rotating modes are now a **deny** list rather than requiring `CLASSIC` exactly, for the
same reason. The residual risk is a genuinely new rotating mode whose name nobody
recognises — narrower than rejecting every new standard queue, and it still has to pass
the structural checks.

**The startup purge removes queues known to be wrong, not queues merely unrecognised.**
It runs with only a stored `queueId`, where the scanner had the whole match to look at, so
checking it against the accept list let a startup task overrule a decision made with far
better information. That is what happened to Ranked 5s: the scanner accepted it on the
structural check, the purge deleted it on every boot, the watcher re-found and re-posted
it, and the same three games came back after every deploy — visible in the logs as
`Removed 3 game(s) from unsupported queues: 3× queue 710`.

Both components now consult one list of queues that positively break the rubrics — ARAM,
Arena, bots, rotating modes — so no queue can be scored by one and deleted by the other.
That invariant is a test, not a coincidence of two lists lining up. Swiftplay is
deliberately not on it: excluding a normal-looking Rift game is a judgement call, and
`BLOCKED_QUEUES` is where judgement calls belong.

**Ranked 5s is queue 710.** Observed in the wild; still absent from Riot's published
`queues.json`, so the structural check is what catches the next one.

**An unreadable database recovers from the last good copy, not from empty.** `read()`
returning empty was never just a failure to load — it is persisted by the very next
`write()`, so a single bad read silently destroyed the entire history, and every stored
game was then re-fetched and re-posted as new. Every successful write now also writes
`db.json.bak`, and a failed read restores from it before considering starting over. The
unreadable file is still preserved as `db.json.corrupt-<timestamp>` either way, and the
recovery path says loudly which of the two happened.

The scratch file a write renames from now carries the pid and a counter. A fixed name is
safe within one process, since these writes are synchronous, but not across two — a deploy
overlaps the old container with the new one on the same volume, and a shared scratch path
is then two writers racing.

**Only one scan runs at a time, process-wide.** A scan reads which games are already
stored, spends a dozen Riot calls fetching and scoring them, and only saves at the very
end. Two overlapping scans therefore both decide the same game is unscored, both score it,
and both post it — one database row, two identical scorecards a minute apart. The watcher
had a guard against overlapping *itself*, but nothing stopped it overlapping a manual
`/fetchgame`, which is the pairing that actually happens: people run `/fetchgame` when
they notice the watcher is due. Scans are serialised rather than rejected, so the second
caller waits and then sees what the first one saved.

**A game is identified by Riot's numeric `gameId`, not by its match id.** Those are
usually interchangeable, and for Ranked 5s they are not: Riot hands the same game back
under more than one match id. The "already scored?" check only knew about match ids, so
each id was treated as a new game — the same match was scored and posted again on every
scan, at whatever interval the watcher ran, and counted toward the backlog, so
`/fetchgame` reported games waiting after the squad had played one. Scans now reject a
match whose `gameId` is already stored, and de-duplicate within a single batch as well,
since nothing has been saved yet at that point. `/resetgames duplicates:true` clears up
anything stored before the fix.

Rejections are versioned against the rules that produced them, so **widening the rules
re-checks games already turned away**. Without that, fixing the filter would never have
reached the games it was written for. Rejection messages always name the raw queue id and
mode (`queue 1234/TOURNAMENT`), because when a brand-new queue is refused that message is
the only evidence of what it was.

A game also has to have been played **on the same team**. Registered players split
across both sides isn't a squad game: teammates would be listed as enemies and the
bench call would compare across the two teams.

`ALLOWED_QUEUES` adds queues to the accept list — e.g. `ALLOWED_QUEUES=420,440,480` to
include Swiftplay. **It does not restrict.** Since an unlisted queue now falls through to
the structural check, leaving something *off* the list no longer excludes it, and a
config that quietly stops restricting is worse than one that never did.

`BLOCKED_QUEUES` is what exclusion means now. It is checked first and beats everything,
including the accept list:

```
BLOCKED_QUEUES=480,490    # never score Swiftplay or Quickplay
```

Swiftplay (480) is the usual candidate: it is a normal-looking Rift game, so the
structural check accepts it, but its accelerated economy skews the gold-at-14 baselines
that every lane grade is built on. Changing either variable re-checks games rejected
under the previous setting.

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

## Riot API keys and stale PUUIDs

**Development keys expire every 24 hours, and PUUIDs are scoped to the key that
issued them.** When the key rotates, every stored PUUID stops working: match-v5
answers `400 Exception decrypting <puuid>` while account-v1 still resolves the Riot ID
perfectly. So `/register` keeps working, the key looks valid, and the bot just quietly
stops finding games.

The bot now self-heals: on that failure it re-resolves the PUUID from the stored Riot ID
(the durable identifier), saves the new one and retries. It also reports the failure
instead of saying "no new matches found" when every player's history call was rejected.

Self-healing only helps if the key itself is current. On a development key you have to
paste a new one into `RIOT_API_KEY` every day. **Apply for a Personal API Key** at
https://developer.riotgames.com/ — it doesn't expire, and it's free for a project like
this one.

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

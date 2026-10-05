// index.js - Discord invite tracker (single file).
// discord.js v14, better-sqlite3, slash commands only, no message content intent.
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Options,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ===========================================================================
// 1. CONFIG
// ===========================================================================
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const OWNER_ID = (process.env.OWNER_ID || '').trim();

if (!DISCORD_TOKEN || !OWNER_ID) {
  console.error('Missing DISCORD_TOKEN or OWNER_ID in your environment/.env file.');
  process.exit(1);
}

const COLOR = 0x5865f2; // one consistent embed color
const NO_MENTIONS = { parse: [] }; // nothing the bot sends can ping anyone
const DELETED_TTL_MS = 15_000;
const NOTICE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// ===========================================================================
// 2. DATABASE (SQLite). Tables are created automatically.
//    joins.source  : 'invite' | 'vanity' | 'unknown'
//    joins.counted : 1 while the join counts toward inviter_stats; set to 0 when
//                    the inviter's stats are reset so old leaves can't go negative.
// ===========================================================================
const dbPath = path.resolve(process.env.DB_PATH || './data/bot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // ~2 MB page cache keeps memory low

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT
  );
  CREATE TABLE IF NOT EXISTS joins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    inviter_id  TEXT,
    invite_code TEXT,
    source      TEXT NOT NULL DEFAULT 'unknown',
    joined_at   INTEGER NOT NULL,
    left_at     INTEGER,
    counted     INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_joins_member  ON joins (guild_id, member_id, id);
  CREATE INDEX IF NOT EXISTS idx_joins_inviter ON joins (guild_id, inviter_id);
  CREATE TABLE IF NOT EXISTS inviter_stats (
    guild_id   TEXT NOT NULL,
    inviter_id TEXT NOT NULL,
    joins      INTEGER NOT NULL DEFAULT 0,
    leaves     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, inviter_id)
  );
`);

const q = {
  getChannel: db.prepare('SELECT channel_id FROM guild_settings WHERE guild_id = ?'),
  setChannel: db.prepare(`
    INSERT INTO guild_settings (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id`),
  clearChannel: db.prepare('DELETE FROM guild_settings WHERE guild_id = ?'),
  activeJoin: db.prepare(`
    SELECT * FROM joins WHERE guild_id = ? AND member_id = ? AND left_at IS NULL
    ORDER BY id DESC LIMIT 1`),
  latestJoin: db.prepare(`
    SELECT * FROM joins WHERE guild_id = ? AND member_id = ?
    ORDER BY id DESC LIMIT 1`),
  insertJoin: db.prepare(`
    INSERT INTO joins (guild_id, member_id, inviter_id, invite_code, source, joined_at)
    VALUES (@guildId, @memberId, @inviterId, @inviteCode, @source, @joinedAt)`),
  markLeft: db.prepare('UPDATE joins SET left_at = ? WHERE id = ?'),
  addJoinStat: db.prepare(`
    INSERT INTO inviter_stats (guild_id, inviter_id, joins, leaves) VALUES (?, ?, 1, 0)
    ON CONFLICT(guild_id, inviter_id) DO UPDATE SET joins = joins + 1`),
  addLeaveStat: db.prepare(
    'UPDATE inviter_stats SET leaves = leaves + 1 WHERE guild_id = ? AND inviter_id = ?'),
  stats: db.prepare('SELECT joins, leaves FROM inviter_stats WHERE guild_id = ? AND inviter_id = ?'),
  leaderboard: db.prepare(`
    SELECT inviter_id, joins, leaves, (joins - leaves) AS current
    FROM inviter_stats WHERE guild_id = ? AND joins > 0
    ORDER BY current DESC, joins DESC LIMIT ?`),
  deleteStats: db.prepare('DELETE FROM inviter_stats WHERE guild_id = ? AND inviter_id = ?'),
  uncountJoins: db.prepare('UPDATE joins SET counted = 0 WHERE guild_id = ? AND inviter_id = ?'),
};

function getChannelId(guildId) {
  return q.getChannel.get(guildId)?.channel_id ?? null;
}

function setChannelId(guildId, channelId) {
  q.setChannel.run(guildId, channelId);
}

/** Returns true if a tracking channel was actually removed. */
function clearChannelId(guildId) {
  return q.clearChannel.run(guildId).changes > 0;
}

/** Closes a join record and counts a leave for its inviter (if it was counted). */
function closeJoin(record, leftAt) {
  q.markLeft.run(leftAt, record.id);
  if (record.inviter_id && record.counted) {
    q.addLeaveStat.run(record.guild_id, record.inviter_id);
  }
}

/**
 * Records a new join. If the member still has an "active" record (their leave was
 * missed, e.g. the bot was offline), it is closed first so the earlier join is
 * never double counted.
 */
const recordJoin = db.transaction(({ guildId, memberId, inviterId, inviteCode, source, joinedAt }) => {
  const stale = q.activeJoin.get(guildId, memberId);
  if (stale) closeJoin(stale, joinedAt);

  q.insertJoin.run({
    guildId,
    memberId,
    inviterId: inviterId ?? null,
    inviteCode: inviteCode ?? null,
    source,
    joinedAt,
  });
  if (inviterId) q.addJoinStat.run(guildId, inviterId);
});

/** Marks the member's active join as left. */
const recordLeave = db.transaction((guildId, memberId) => {
  const active = q.activeJoin.get(guildId, memberId);
  if (active) closeJoin(active, Date.now());
});

function getLatestJoin(guildId, memberId) {
  return q.latestJoin.get(guildId, memberId) ?? null;
}

function getStats(guildId, inviterId) {
  const row = q.stats.get(guildId, inviterId);
  const joins = row?.joins ?? 0;
  const leaves = row?.leaves ?? 0;
  return { joins, leaves, current: joins - leaves };
}

function getLeaderboard(guildId, limit = 10) {
  return q.leaderboard.all(guildId, limit).map((r) => ({
    inviterId: r.inviter_id,
    joins: r.joins,
    leaves: r.leaves,
    current: r.current,
  }));
}

/** Resets stats. Old join records stay (for /whoinvited) but stop counting. */
const resetStats = db.transaction((guildId, inviterId) => {
  q.deleteStats.run(guildId, inviterId);
  q.uncountJoins.run(guildId, inviterId);
});

// ===========================================================================
// 3. HELPERS (embeds, replies, formatting)
// ===========================================================================
function embed(title, description) {
  const e = new EmbedBuilder().setColor(COLOR);
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

const fullDate = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;
const relativeDate = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

/** Replies (or follows up). Never throws, so a failed reply can't crash the bot. */
async function safeReply(interaction, payload) {
  const options = { allowedMentions: NO_MENTIONS, ...payload };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(options);
    return await interaction.reply(options);
  } catch (err) {
    console.error('Failed to reply to interaction:', err);
    return null;
  }
}

function send(interaction, embeds, { ephemeral = false } = {}) {
  const payload = { embeds: Array.isArray(embeds) ? embeds : [embeds] };
  if (ephemeral) payload.flags = MessageFlags.Ephemeral;
  return safeReply(interaction, payload);
}

function describeInviter(record) {
  if (record.source === 'vanity') return 'Vanity URL';
  if (record.inviter_id) return `<@${record.inviter_id}>`;
  return 'Unknown';
}

// ===========================================================================
// 4. INVITE TRACKER (cache + join detection)
// ===========================================================================
const inviteCache = new Map(); // guildId -> Map(code -> { uses, maxUses, inviterId })
const vanityUses = new Map(); // guildId -> last known vanity use count
const recentlyDeleted = new Map(); // guildId -> Map(code -> { entry, at })
const lastPermissionNotice = new Map(); // guildId -> timestamp
const queues = new Map(); // guildId -> promise chain (keeps joins in order)

function toEntry(invite) {
  return {
    uses: invite.uses ?? 0,
    maxUses: invite.maxUses ?? 0,
    inviterId: invite.inviterId ?? invite.inviter?.id ?? null,
  };
}

function toCache(invites) {
  const map = new Map();
  for (const invite of invites.values()) map.set(invite.code, toEntry(invite));
  return map;
}

/** True if one more use exhausts this invite (Discord then deletes it). */
function isLastUse(entry) {
  return entry.maxUses > 0 && entry.uses + 1 >= entry.maxUses;
}

function canReadInvites(guild) {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild));
}

/** Runs tasks for one guild strictly in arrival order. */
function enqueue(guildId, task) {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(guildId, next);
  next
    .finally(() => {
      if (queues.get(guildId) === next) queues.delete(guildId);
    })
    .catch(() => {});
  return next;
}

async function getTrackingChannel(guild) {
  const channelId = getChannelId(guild.id);
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

/** Tells the owner the bot can't read invites (tracking channel, else console). */
async function reportMissingPermission(guild) {
  const last = lastPermissionNotice.get(guild.id) ?? 0;
  if (Date.now() - last < NOTICE_COOLDOWN_MS) return;
  lastPermissionNotice.set(guild.id, Date.now());

  const text =
    'I need the **Manage Server** permission to read invites. ' +
    'Until it is granted, new joins will be recorded as "Unknown".';

  try {
    const channel = await getTrackingChannel(guild);
    if (channel) {
      await channel.send({
        embeds: [embed('Missing permission', `<@${OWNER_ID}> ${text}`)],
        allowedMentions: NO_MENTIONS,
      });
      return;
    }
  } catch (err) {
    console.warn(`[${guild.name}] Could not post permission notice:`, err.message);
  }
  console.warn(`[${guild.name}] ${text.replace(/\*\*/g, '')}`);
}

/** Fetches and caches all invites (and vanity uses) for a guild. */
async function cacheGuildInvites(guild) {
  if (!canReadInvites(guild)) {
    inviteCache.delete(guild.id);
    await reportMissingPermission(guild);
    return;
  }

  try {
    inviteCache.set(guild.id, toCache(await guild.invites.fetch()));
  } catch (err) {
    inviteCache.delete(guild.id);
    console.warn(`[${guild.name}] Could not fetch invites:`, err.message);
    return;
  }

  if (guild.features.includes('VANITY_URL')) {
    try {
      vanityUses.set(guild.id, (await guild.fetchVanityData()).uses);
    } catch {
      // Vanity data is optional.
    }
  }
}

function dropGuild(guildId) {
  inviteCache.delete(guildId);
  vanityUses.delete(guildId);
  recentlyDeleted.delete(guildId);
  lastPermissionNotice.delete(guildId);
}

function addInvite(invite) {
  const cache = invite.guild && inviteCache.get(invite.guild.id);
  if (cache) cache.set(invite.code, toEntry(invite));
}

function removeInvite(invite) {
  const guildId = invite.guild?.id;
  const cache = guildId && inviteCache.get(guildId);
  const entry = cache?.get(invite.code);
  if (!entry) return;

  cache.delete(invite.code);

  // Remember briefly: a max-use invite can be deleted before the member-add event.
  const stash = recentlyDeleted.get(guildId) ?? new Map();
  const now = Date.now();
  for (const [code, item] of stash) {
    if (now - item.at > DELETED_TTL_MS) stash.delete(code);
  }
  stash.set(invite.code, { entry, at: now });
  recentlyDeleted.set(guildId, stash);
}

/** Works out how a member joined. Always refreshes the cache. */
async function detectInvite(guild) {
  const unknown = { source: 'unknown', inviterId: null, code: null };

  if (!canReadInvites(guild)) {
    await reportMissingPermission(guild);
    return unknown;
  }

  let current;
  try {
    current = await guild.invites.fetch();
  } catch (err) {
    console.warn(`[${guild.name}] Could not fetch invites on join:`, err.message);
    return unknown;
  }

  const next = toCache(current);
  const previous = inviteCache.get(guild.id);
  inviteCache.set(guild.id, next);
  if (!previous) return unknown; // nothing to compare against yet

  // 1) An invite whose use count went up.
  for (const [code, entry] of next) {
    if (entry.uses > (previous.get(code)?.uses ?? 0)) {
      return { source: 'invite', inviterId: entry.inviterId, code };
    }
  }

  // 2) An invite that vanished because its final use was just consumed.
  const stash = recentlyDeleted.get(guild.id) ?? new Map();
  const missing = [];
  for (const [code, entry] of previous) {
    if (!next.has(code)) missing.push([code, entry]);
  }
  for (const [code, item] of stash) {
    if (Date.now() - item.at <= DELETED_TTL_MS && !next.has(code)) missing.push([code, item.entry]);
  }
  const consumed = missing.find(([, entry]) => isLastUse(entry));
  if (consumed) {
    stash.delete(consumed[0]);
    return { source: 'invite', inviterId: consumed[1].inviterId, code: consumed[0] };
  }

  // 3) The vanity URL.
  if (guild.features.includes('VANITY_URL')) {
    try {
      const vanity = await guild.fetchVanityData();
      const before = vanityUses.get(guild.id);
      vanityUses.set(guild.id, vanity.uses);
      if (before !== undefined && vanity.uses > before) {
        return { source: 'vanity', inviterId: null, code: vanity.code ?? guild.vanityURLCode ?? null };
      }
    } catch {
      // Fall through to unknown.
    }
  }

  return unknown;
}

async function sendJoinMessage(member, detected) {
  const channel = await getTrackingChannel(member.guild);
  if (!channel) return;

  let inviterText = 'Unknown';
  let countText = 'N/A';
  if (detected.source === 'vanity') {
    inviterText = 'Vanity URL';
  } else if (detected.inviterId) {
    inviterText = `<@${detected.inviterId}>`;
    countText = String(getStats(member.guild.id, detected.inviterId).current);
  }

  const created = member.user.createdTimestamp;
  const message = embed('Member joined')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Member', value: `<@${member.id}>`, inline: true },
      { name: 'Invited by', value: inviterText, inline: true },
      { name: "Inviter's invites", value: countText, inline: true },
      { name: 'Account created', value: `${fullDate(created)} (${relativeDate(created)})` },
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [message], allowedMentions: NO_MENTIONS });
  } catch (err) {
    console.warn(`[${member.guild.name}] Could not send join message:`, err.message);
  }
}

function handleJoin(member) {
  return enqueue(member.guild.id, async () => {
    const detected = await detectInvite(member.guild);
    recordJoin({
      guildId: member.guild.id,
      memberId: member.id,
      inviterId: detected.inviterId,
      inviteCode: detected.code,
      source: detected.source,
      joinedAt: Date.now(),
    });
    await sendJoinMessage(member, detected);
  });
}

function handleLeave(member) {
  return enqueue(member.guild.id, async () => recordLeave(member.guild.id, member.id));
}

// ===========================================================================
// 5. SLASH COMMANDS
// ===========================================================================
const commands = [
  // /set channel:<text channel>
  {
    data: new SlashCommandBuilder()
      .setName('set')
      .setDescription('Set the channel where join messages are posted')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('The tracking channel')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const channel = interaction.options.getChannel('channel', true);
      setChannelId(interaction.guildId, channel.id);

      const result = embed('Tracking channel set', `Join messages will be posted in <#${channel.id}>.`);

      // Warn if the bot can't post there.
      const me = interaction.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms) {
        const missing = [
          [PermissionFlagsBits.ViewChannel, 'View Channel'],
          [PermissionFlagsBits.SendMessages, 'Send Messages'],
          [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
        ]
          .filter(([flag]) => !perms.has(flag))
          .map(([, name]) => name);
        if (missing.length) {
          result.addFields({
            name: 'Warning',
            value: `I'm missing these permissions in that channel: ${missing.join(', ')}.`,
          });
        }
      }
      await send(interaction, result);
    },
  },

  // /unset
  {
    data: new SlashCommandBuilder()
      .setName('unset')
      .setDescription('Remove the tracking channel')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const removed = clearChannelId(interaction.guildId);
      await send(
        interaction,
        removed
          ? embed('Tracking channel removed', 'Join messages are off. Joins are still being tracked.')
          : embed('Nothing to remove', 'No tracking channel was set.'),
      );
    },
  },

  // /invites user:<optional>
  {
    data: new SlashCommandBuilder()
      .setName('invites')
      .setDescription("Show a member's invite stats")
      .addUserOption((o) => o.setName('user').setDescription('Member to look up (defaults to you)'))
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const user = interaction.options.getUser('user') ?? interaction.user;
      const stats = getStats(interaction.guildId, user.id);

      await send(
        interaction,
        embed('Invite stats', `Stats for <@${user.id}>`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'Current', value: String(stats.current), inline: true },
            { name: 'Total joins', value: String(stats.joins), inline: true },
            { name: 'Leaves', value: String(stats.leaves), inline: true },
          ),
      );
    },
  },

  // /leaderboard
  {
    data: new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('Show the top 10 inviters')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const rows = getLeaderboard(interaction.guildId, 10);
      if (rows.length === 0) {
        await send(
          interaction,
          embed('Invite leaderboard', 'No invites have been tracked yet. Check back after some members join.'),
        );
        return;
      }

      const lines = rows.map(
        (r, i) =>
          `**${i + 1}.** <@${r.inviterId}> - **${r.current}** current (${r.joins} joins, ${r.leaves} leaves)`,
      );
      await send(interaction, embed('Invite leaderboard', lines.join('\n')));
    },
  },

  // /whoinvited user:<required>
  {
    data: new SlashCommandBuilder()
      .setName('whoinvited')
      .setDescription('Show who invited a member')
      .addUserOption((o) => o.setName('user').setDescription('The member to look up').setRequired(true))
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      const record = getLatestJoin(interaction.guildId, user.id);

      if (!record) {
        await send(
          interaction,
          embed(
            'No record found',
            `I have no join record for <@${user.id}>. They may have joined before the bot started tracking.`,
          ),
        );
        return;
      }

      await send(
        interaction,
        embed('Who invited', `Latest join record for <@${user.id}>`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'Invited by', value: describeInviter(record), inline: true },
            { name: 'Invite code', value: record.invite_code ? `\`${record.invite_code}\`` : 'N/A', inline: true },
            { name: 'Joined', value: `${fullDate(record.joined_at)} (${relativeDate(record.joined_at)})` },
            {
              name: 'Status',
              value: record.left_at ? `Left ${fullDate(record.left_at)}` : 'Still in the server',
            },
          ),
      );
    },
  },

  // /resetinvites user:<required> (with confirmation button, 60 s timeout)
  {
    data: new SlashCommandBuilder()
      .setName('resetinvites')
      .setDescription("Reset a user's invite stats")
      .addUserOption((o) =>
        o.setName('user').setDescription('The user whose stats will be reset').setRequired(true),
      )
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const user = interaction.options.getUser('user', true);
      const stats = getStats(interaction.guildId, user.id);
      const suffix = interaction.id;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`reset-confirm:${suffix}`)
          .setLabel('Confirm reset')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`reset-cancel:${suffix}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      await interaction.reply({
        embeds: [
          embed(
            'Confirm reset',
            `Reset invite stats for <@${user.id}>?\n` +
              `Current: **${stats.current}**, joins: **${stats.joins}**, leaves: **${stats.leaves}**.\n` +
              'This cannot be undone. You have 60 seconds to confirm.',
          ),
        ],
        components: [row],
        allowedMentions: NO_MENTIONS,
      });
      const message = await interaction.fetchReply();

      try {
        const choice = await message.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 60_000,
          filter: (i) => i.user.id === OWNER_ID && i.customId.endsWith(`:${suffix}`),
        });

        if (choice.customId.startsWith('reset-confirm')) {
          resetStats(interaction.guildId, user.id);
          await choice.update({
            embeds: [embed('Stats reset', `Invite stats for <@${user.id}> have been reset.`)],
            components: [],
            allowedMentions: NO_MENTIONS,
          });
        } else {
          await choice.update({
            embeds: [embed('Cancelled', 'No changes were made.')],
            components: [],
            allowedMentions: NO_MENTIONS,
          });
        }
      } catch {
        // awaitMessageComponent rejects when the 60 seconds run out.
        await interaction
          .editReply({
            embeds: [embed('Timed out', 'No confirmation received. No changes were made.')],
            components: [],
            allowedMentions: NO_MENTIONS,
          })
          .catch(() => {});
      }
    },
  },

  // /status
  {
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show tracking channel, cached invites, and permission status')
      .setContexts(InteractionContextType.Guild),

    async execute(interaction) {
      const guild = interaction.guild;
      const me = guild.members.me ?? (await guild.members.fetchMe());

      const channelId = getChannelId(guild.id);
      const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      let channelText = 'Not set';
      if (channelId) channelText = channel ? `<#${channel.id}>` : 'Not found (use /set again)';

      const cached = inviteCache.get(guild.id)?.size;
      const cachedText = cached === undefined ? 'Not loaded (needs Manage Server)' : String(cached);

      // Manage Server is server-wide; the rest are checked in the tracking channel if set.
      const channelPerms = channel ? channel.permissionsFor(me) : me.permissions;
      const checks = [
        ['Manage Server', me.permissions.has(PermissionFlagsBits.ManageGuild)],
        ['View Channels', channelPerms.has(PermissionFlagsBits.ViewChannel)],
        ['Send Messages', channelPerms.has(PermissionFlagsBits.SendMessages)],
        ['Embed Links', channelPerms.has(PermissionFlagsBits.EmbedLinks)],
      ];
      const allOk = checks.every(([, ok]) => ok);

      await send(
        interaction,
        embed('Bot status', allOk ? 'All required permissions are in place.' : 'Some permissions are missing.')
          .addFields(
            { name: 'Tracking channel', value: channelText, inline: true },
            { name: 'Cached invites', value: cachedText, inline: true },
            {
              name: channel ? 'Permissions (in tracking channel)' : 'Permissions (server-wide)',
              value: checks.map(([name, ok]) => `${ok ? '✅' : '❌'} ${name}`).join('\n'),
            },
          ),
      );
    },
  },
];

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

/** Registers slash commands: to GUILD_ID if set (instant), otherwise globally. */
async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const appId = CLIENT_ID || client.user.id;
  const body = commands.map((c) => c.data.toJSON());

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), { body });
    console.log(`Registered ${body.length} command(s) to guild ${GUILD_ID}.`);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log(`Registered ${body.length} command(s) globally (may take up to an hour to appear).`);
  }
}

// ===========================================================================
// 6. CLIENT + EVENTS
// ===========================================================================
// Only the intents we need, and tight caches for a 256 MB host.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites],
  allowedMentions: NO_MENTIONS,
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    VoiceStateManager: 0,
    StageInstanceManager: 0,
    ThreadManager: 0,
    ThreadMemberManager: 0,
    GuildScheduledEventManager: 0,
    GuildBanManager: 0,
    GuildInviteManager: 0, // we keep our own lightweight invite cache
    GuildMemberManager: { maxSize: 100, keepOverLimit: (m) => m.id === m.client.user.id },
    UserManager: { maxSize: 100, keepOverLimit: (u) => u.id === u.client.user.id },
  }),
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);

  try {
    await registerCommands(c);
  } catch (err) {
    console.error('Failed to register commands:', err);
  }

  for (const guild of c.guilds.cache.values()) {
    await cacheGuildInvites(guild).catch((err) => console.error('Invite cache error:', err));
  }
  console.log('Invite cache ready.');
});

client.on(Events.GuildCreate, (guild) => {
  // Servers present at startup are handled in ClientReady; this covers new ones.
  if (!client.isReady()) return;
  cacheGuildInvites(guild).catch((err) => console.error('Invite cache error:', err));
});

client.on(Events.GuildDelete, (guild) => dropGuild(guild.id));

client.on(Events.InviteCreate, (invite) => {
  try {
    addInvite(invite);
  } catch (err) {
    console.error('inviteCreate error:', err);
  }
});

client.on(Events.InviteDelete, (invite) => {
  try {
    removeInvite(invite);
  } catch (err) {
    console.error('inviteDelete error:', err);
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  handleJoin(member).catch((err) => console.error('guildMemberAdd error:', err));
});

client.on(Events.GuildMemberRemove, (member) => {
  handleLeave(member).catch((err) => console.error('guildMemberRemove error:', err));
});

// Owner-only access control runs first, for every interaction (commands and buttons).
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.user.id !== OWNER_ID) {
      if (interaction.isRepliable()) {
        await safeReply(interaction, {
          embeds: [embed(null, "You don't have permission to use this command.")],
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Buttons are handled by the collector inside /resetinvites.
    if (!interaction.isChatInputCommand()) return;

    // Servers only.
    if (!interaction.inGuild() || !interaction.guild) {
      await safeReply(interaction, {
        embeds: [embed(null, 'This command can only be used in a server.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const command = commandMap.get(interaction.commandName);
    if (command) await command.execute(interaction);
  } catch (err) {
    // A failing command must never crash the bot.
    console.error(`Error in interaction "${interaction.commandName ?? interaction.customId}":`, err);
    await safeReply(interaction, {
      embeds: [embed('Something went wrong', 'The command failed. Check the console for details.')],
      flags: MessageFlags.Ephemeral,
    });
  }
});

// ===========================================================================
// 7. GLOBAL ERROR HANDLING + SHUTDOWN
// ===========================================================================
client.on(Events.Error, (err) => console.error('Client error:', err));
client.on(Events.Warn, (msg) => console.warn('Client warning:', msg));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  try {
    client.destroy();
    db.close();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});

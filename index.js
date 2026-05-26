import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildMember,
  Interaction,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
} from "discord.js";
import express from "express";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VERIFIED_TESTER_ROLE_NAME = "Verified Tester";

if (!TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required.");
  process.exit(1);
}

const app = express();
app.get("/", (req, res) => res.send("Apex Tiers Bot is Online!"));
app.listen(process.env.PORT || 3000, () => console.log("Web server ready."));

const queues = new Map();

function hasTesterRole(member) {
  return member.roles.cache.some((role) => role.name === VERIFIED_TESTER_ROLE_NAME) || member.permissions.has("Administrator");
}

const commands = [
  new SlashCommandBuilder()
    .setName("setupcontrol")
    .setDescription("Set up an Apex Tiers queue control panel in this channel.")
    .addStringOption((opt) =>
      opt.setName("name").setDescription('Queue name (e.g. "sword waitlist")').setRequired(true)
    )
    .addChannelOption((opt) =>
      opt.setName("channel").setDescription("Channel where the player interface will be posted (defaults to this one)").setRequired(false)
    )
    .toJSON(),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once("ready", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  const rest = new REST().setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, GUILD_ID), { body: commands });
    } else {
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    }
    console.log("Commands registered successfully.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "setupcontrol") {
    const member = interaction.member;
    if (!hasTesterRole(member)) {
      return interaction.reply({ content: `❌ You must have the "${VERIFIED_TESTER_ROLE_NAME}" role to use this.`, ephemeral: true });
    }

    const name = interaction.options.getString("name", true).toLowerCase();
    const targetChannel = (interaction.options.getChannel("channel") || interaction.channel);

    const controlEmbed = new EmbedBuilder()
      .setTitle(`🎛️ Control Panel: ${name.toUpperCase()}`)
      .setDescription(`**Current Status:** Closed 🔴\n**Active Tester:** None`)
      .setColor("#f04747");

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`open_queue::${name}`).setLabel("Open Queue").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`close_queue::${name}`).setLabel("Close Queue").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`pull_player::${name}`).setLabel("Pull Player").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ping_queue::${name}`).setLabel("Ping Queue").setStyle(ButtonStyle.Secondary)
    );

    const msg = await interaction.reply({ embeds: [controlEmbed], components: [row], fetchReply: true });

    queues.set(name, {
      name,
      status: "closed",
      testerId: "",
      testerName: "",
      players: [],
      controlPanelChannelId: interaction.channelId,
      controlPanelMessageId: msg.id,
      playerPanelChannelId: targetChannel.id,
      playerPanelMessageId: null,
    });
    return;
  }

  if (interaction.isButton()) {
    const [action, name] = interaction.customId.split("::");
    const queue = queues.get(name);
    if (!queue) return interaction.reply({ content: "❌ Queue profile data not found.", ephemeral: true });

    const member = interaction.member;

    if (action === "join_queue" || action === "leave_queue") {
      if (queue.status === "closed") return interaction.reply({ content: "❌ This queue is closed.", ephemeral: true });
      
      if (action === "join_queue") {
        if (queue.players.some((p) => p.id === interaction.user.id)) {
          return interaction.reply({ content: "❌ You are already in this queue.", ephemeral: true });
        }
        queue.players.push({ id: interaction.user.id, username: interaction.user.username, displayName: member.displayName });
        await interaction.reply({ content: "✅ Joined the queue!", ephemeral: true });
      } else {
        const idx = queue.players.findIndex((p) => p.id === interaction.user.id);
        if (idx === -1) return interaction.reply({ content: "❌ You are not in this queue.", ephemeral: true });
        queue.players.splice(idx, 1);
        await interaction.reply({ content: "🛑 Left the queue.", ephemeral: true });
      }
      await updatePlayerPanel(interaction.guild, queue);
      return;
    }

    if (!hasTesterRole(member)) {
      return interaction.reply({ content: "❌ Access Denied: Designated testers only.", ephemeral: true });
    }

    if (action === "open_queue") {
      queue.status = "open";
      queue.testerId = interaction.user.id;
      queue.testerName = member.displayName;
      await interaction.reply({ content: "🟢 Queue opened!", ephemeral: true });
      await updateControlPanel(interaction, queue);
      await updatePlayerPanel(interaction.guild, queue);
    } else if (action === "close_queue") {
      queue.status = "closed";
      queue.players = [];
      await interaction.reply({ content: "🔴 Queue closed.", ephemeral: true });
      await updateControlPanel(interaction, queue);
      await updatePlayerPanel(interaction.guild, queue);
    } else if (action === "pull_player") {
      if (queue.players.length === 0) return interaction.reply({ content: "❌ The queue is empty.", ephemeral: true });
      
      const target = queue.players.shift();
      await interaction.reply({ content: `🔄 Pulling <@${target.id}>...`, ephemeral: true });

      const channel = interaction.channel;
      const thread = await channel.threads.create({
        name: `⚔️┃test-${target.username}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
        type: ChannelType.PrivateThread,
      });

      await thread.members.add(interaction.user.id);
      await thread.members.add(target.id);
      await thread.send({ content: `⚔️ **Apex Tiers Arena Ready!**\nTester: <@${interaction.user.id}>\nCandidate: <@${target.id}>` });

      await updatePlayerPanel(interaction.guild, queue);
    } else if (action === "ping_queue") {
      if (queue.players.length === 0) return interaction.reply({ content: "❌ Nobody is in the queue.", ephemeral: true });
      const pings = queue.players.map((p) => `<@${p.id}>`).join(" ");
      const channel = interaction.channel;
      await channel.send({ content: `⚠️ **Apex Tiers Alert:** ${pings} - Your tester is ready!` });
      await interaction.reply({ content: "✅ Pings broadcasted.", ephemeral: true });
    }
  }
});

async function updateControlPanel(interaction, queue) {
  const embed = new EmbedBuilder()
    .setTitle(`🎛️ Control Panel: ${queue.name.toUpperCase()}`)
    .setDescription(`**Current Status:** ${queue.status === "open" ? "Open 🟢" : "Closed 🔴"}\n**Active Tester:** ${queue.status === "open" ? queue.testerName : "None"}`)
    .setColor(queue.status === "open" ? "#43b581" : "#f04747");
  await interaction.message.edit({ embeds: [embed] });
}

async function updatePlayerPanel(guild, queue) {
  if (!queue.playerPanelChannelId) return;
  const channel = await guild.channels.fetch(queue.playerPanelChannelId).catch(() => null);
  if (!channel) return;

  if (queue.status === "closed") {
    const closedEmbed = new EmbedBuilder()
      .setTitle(`🔴 ${queue.name.toUpperCase()} Locked`)
      .setDescription(`⚠️ **No testers are online right now.**\nPlease wait until a Verified Tester opens the match queue.`)
      .setColor("#f04747");

    if (queue.playerPanelMessageId) {
      const msg = await channel.messages.fetch(queue.playerPanelMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [closedEmbed], components: [] });
        return;
      }
    }
    const sent = await channel.send({ embeds: [closedEmbed] });
    queue.playerPanelMessageId = sent.id;
    return;
  }

  const listText = queue.players.length > 0 
    ? queue.players.map((p, i) => `**#${i + 1}** ┃ <@${p.id}> (${p.displayName})`).join("\n")
    : "*The queue is currently empty.*";

  const openEmbed = new EmbedBuilder()
    .setTitle(`⚔️ Apex Tiers: ${queue.name.toUpperCase()}`)
    .setDescription(`**👑 Handling Tester:** ${queue.testerName}\n\n**📋 Live Waiting List:**\n${listText}`)
    .setColor("#43b581");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`join_queue::${queue.name}`).setLabel("Join Queue").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave_queue::${queue.name}`).setLabel("Leave Queue").setStyle(ButtonStyle.Danger)
  );

  if (queue.playerPanelMessageId) {
    const msg = await channel.messages.fetch(queue.playerPanelMessageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [openEmbed], components: [row] });
      return;
    }
  }

  await channel.send({ content: `📢 **The Apex Tiers queue [${queue.name.toUpperCase()}] is now OPEN!** @everyone` });
  const sent = await channel.send({ embeds: [openEmbed], components: [row] });
  queue.playerPanelMessageId = sent.id;
}

client.login(TOKEN);
      

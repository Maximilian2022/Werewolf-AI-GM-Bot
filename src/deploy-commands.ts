/**
 * src/deploy-commands.ts
 */
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
dotenv.config();

const token = process.env.GM_BOT_TOKEN;
const clientId = process.env.GM_CLIENT_ID;
const guildId = process.env.TEST_GUILD_ID || '1502707892485099623'; 

if (!token || !clientId) process.exit(1);

const commands = [
  new SlashCommandBuilder().setName('開始').setDescription('ゲームを開始').addBooleanOption(o => o.setName('debug').setDescription('デバッグ')).addIntegerOption(o => o.setName('人数').setDescription('人数指定').setChoices({ name: '11人村', value: 11 }, { name: '13人村', value: 13 })),
  new SlashCommandBuilder().setName('再開').setDescription('ゲームを再開').addStringOption(o => o.setName('ゲームid').setDescription('ID').setRequired(true)),
  new SlashCommandBuilder().setName('ミュート解除').setDescription('緊急解除'),
  new SlashCommandBuilder().setName('廃村').setDescription('強制削除').addStringOption(o => o.setName('ゲームid').setDescription('ID').setRequired(true)),
  new SlashCommandBuilder().setName('再解析').setDescription('MVP再解析').addStringOption(o => o.setName('ゲームid').setDescription('ID').setRequired(true)),
  // 🚨 新規追加
  new SlashCommandBuilder().setName('観戦').setDescription('現在進行中のゲームに観戦者（霊界）として途中参加します'),
  new SlashCommandBuilder().setName('設定').setDescription('【管理者用】ゲームの制限時間などを設定します')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('✅ コマンド同期完了');
  } catch (error) { console.error('❌ 同期エラー:', error); }
})();
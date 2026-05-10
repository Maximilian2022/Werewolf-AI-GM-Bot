/**
 * src/index.ts
 * フルコード版：新コマンドの同期 ＆ GUIルーティング対応
 */
import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import * as dotenv from 'dotenv';
import * as dns from 'dns';

import { StateManager } from './state/StateManager';
import { ActionQueue } from './state/ActionQueue';
import { CommandHandler } from './handlers/CommandHandler';
import { WorkerManager } from './managers/WorkerManager';
import { VCWatcher } from './managers/VCWatcher';
import { Logger } from './utils/logger';

// Node.jsのDNS解決をIPv4優先にする（通信安定化のため）
dns.setDefaultResultOrder('ipv4first');
dotenv.config();

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMembers,
];

const gmClient = new Client({ intents });
const assistantClient = new Client({ intents });

StateManager.getInstance();
ActionQueue.getInstance();

async function syncCommands(token: string, clientId: string) {
  const guildId = process.env.TEST_GUILD_ID || '1502707892485099623'; 
  
  // 🚨 修正: ここに観戦と設定を追加し、起動時の上書き消去を防ぐ
  const commands = [
    new SlashCommandBuilder().setName('開始').setDescription('人狼ゲームの環境を構築し、ゲームを開始します')
      .addBooleanOption(o => o.setName('debug').setDescription('デバッグモードで起動').setRequired(false))
      .addIntegerOption(o => o.setName('人数').setDescription('【Debug用】合計参加人数を指定').setChoices({ name: '11人村', value: 11 }, { name: '13人村', value: 13 }).setRequired(false)),
    new SlashCommandBuilder().setName('再開').setDescription('中断されたゲームをセーブデータから再開します')
      .addStringOption(o => o.setName('ゲームid').setDescription('再開するゲームのIDを指定してください').setRequired(true)),
    new SlashCommandBuilder().setName('ミュート解除').setDescription('【緊急用】全員のサーバーミュートを強制解除します'),
    new SlashCommandBuilder().setName('廃村').setDescription('【管理者用】指定したゲームIDの村を強制的に削除します')
      .addStringOption(o => o.setName('ゲームid').setDescription('削除するゲームのIDを指定してください').setRequired(true)),
    new SlashCommandBuilder().setName('再解析').setDescription('【管理者用】終了したゲームの録音データから、MVP解析のみをやり直します')
      .addStringOption(o => o.setName('ゲームid').setDescription('解析をやり直すゲームのIDを指定してください').setRequired(true)),
    new SlashCommandBuilder().setName('観戦').setDescription('現在進行中のゲームに観戦者（霊界）として途中参加します'),
    new SlashCommandBuilder().setName('設定').setDescription('【管理者用】ゲームの制限時間などを設定します')
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    Logger.info('Index', `🔄 テストサーバー [${guildId}] へスラッシュコマンドを同期しています...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    Logger.success('Index', '✅ スラッシュコマンドの同期が完了しました。');
  } catch (error) {
    Logger.error('Index', '❌ コマンドの同期中にエラーが発生しました', error);
  }
}

async function bootstrap() {
  Logger.system('アプリケーションの起動シーケンスを開始します...');

  gmClient.once(Events.ClientReady, async (c) => {
    Logger.success('Index', `[GM Bot] Ready! Logged in as ${c.user.tag}`);
    if (process.env.GM_BOT_TOKEN && process.env.GM_CLIENT_ID) {
      await syncCommands(process.env.GM_BOT_TOKEN, process.env.GM_CLIENT_ID);
    }
  });

  assistantClient.once(Events.ClientReady, (c) => {
    Logger.success('Index', `[Assistant Bot] Ready! Logged in as ${c.user.tag}`);
  });

  gmClient.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        Logger.info('Index', `コマンド実行: [/${interaction.commandName}]`);
        if (interaction.commandName === '開始') await CommandHandler.handleStart(interaction, gmClient, assistantClient);
        else if (interaction.commandName === '再開') await CommandHandler.handleResume(interaction, gmClient, assistantClient);
        else if (interaction.commandName === 'ミュート解除') await CommandHandler.handleEmergencyUnmute(interaction);
        else if (interaction.commandName === '廃村') await CommandHandler.handleAbandon(interaction);
        else if (interaction.commandName === '再解析') await CommandHandler.handleReanalyze(interaction);
        else if (interaction.commandName === '観戦') await CommandHandler.handleSpectate(interaction);
        else if (interaction.commandName === '設定') await CommandHandler.handleSettings(interaction);
      } 
      else if (interaction.isButton()) {
        if (interaction.customId.startsWith('settings_')) await CommandHandler.handleSettingsButton(interaction);
      } 
      else if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('modal_settings_')) await CommandHandler.handleSettingsModal(interaction);
      }
    } catch (error) {
      Logger.error('Index', `インタラクション処理エラー`, error);
    }
  });

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  try {
    const gmToken = process.env.GM_BOT_TOKEN;
    const assistantToken = process.env.ASSISTANT_BOT_TOKEN;

    if (!gmToken || !assistantToken) throw new Error('環境変数に Bot Token が設定されていません。');

    Logger.info('Index', 'Discord APIへのログインを試行しています...');
    
    const loginPromises: Promise<any>[] = [gmClient.login(gmToken), assistantClient.login(assistantToken)];
    const workerTokensStr = process.env.WORKER_TOKENS;

    if (workerTokensStr) {
      const workerTokens = workerTokensStr.split(',').map(t => t.trim()).filter(t => t.length > 0);
      if (workerTokens.length > 0) {
        loginPromises.push(WorkerManager.getInstance().init(workerTokens));
      } else {
        Logger.info('Index', 'WORKER_TOKENSは空です。バイトBotなしで起動します。');
      }
    }

    await Promise.all(loginPromises);
    Logger.system('全てのBotクライアントが正常に起動しました。待機状態に入ります。');

  } catch (error) {
    Logger.error('Index', '起動シーケンス中に致命的なエラーが発生しました', error);
    process.exit(1);
  }
}

function handleShutdown() {
  Logger.system('終了シグナルを受信しました。安全にシャットダウンします...');
  try {
    VCWatcher.getInstance().stop();
    gmClient.destroy();
    assistantClient.destroy();
    WorkerManager.getInstance().destroyAll(); 
    Logger.system('クライアントを破棄しました。プロセスを終了します。');
    process.exit(0);
  } catch (error) {
    Logger.error('Index', 'シャットダウン中にエラーが発生しました', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', error => { Logger.error('System', 'Unhandled promise rejection:', error); });
bootstrap();
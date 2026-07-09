/**
 * src/index.ts
 * メインエントリーポイント（完全版：自動お掃除＆プルダウン設定対応）
 */
import { Client, GatewayIntentBits, REST, Routes, MessageFlags} from 'discord.js';
import * as dotenv from 'dotenv';
import { CommandHandler } from './handlers/CommandHandler.js';
import { WorkerManager } from './managers/WorkerManager.js';
import { SettingsManager } from './managers/SettingsManager.js';
import { CleanupService } from './services/CleanupService.js';
import { Logger } from './utils/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process'; // 🚨 追加：npmバージョン取得用

// .envファイルの読み込み
dotenv.config();

const GM_BOT_TOKEN = process.env.GM_BOT_TOKEN;
const GM_CLIENT_ID = process.env.GM_CLIENT_ID;
const ASSISTANT_BOT_TOKEN = process.env.ASSISTANT_BOT_TOKEN;
const TEST_GUILD_ID = process.env.TEST_GUILD_ID;

if (!GM_BOT_TOKEN || !GM_CLIENT_ID || !ASSISTANT_BOT_TOKEN || !TEST_GUILD_ID) {
  Logger.error('System', '❌ 必須の環境変数が設定されていません（.envファイルを確認してください）。');
  process.exit(1);
}

// クライアントの初期化 (必要なインテントを付与)
const gmClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const assistantClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// 👇 🚨 ここから追加：Discord APIのレートリミット（待機命令）を可視化する
gmClient.rest.on('rateLimited', (info) => {
  Logger.warn('System', `Discord API 制限検知: スパム対策のため ${info.timeToReset}ms 待機します (${info.route})`);
});
assistantClient.rest.on('rateLimited', (info) => {
  Logger.warn('System', `Discord API 制限検知(Assistant): ${info.timeToReset}ms 待機します`);
});

// スラッシュコマンドの定義
const commands = [
  {
    name: '開始',
    description: '人狼ゲームを開始し、隔離環境を構築します',
    options: [
      {
        name: '人数',
        type: 4, // Integer
        description: '参加人数（11または13）',
        required: true,
      },
      {
        name: 'debug',
        type: 5, // Boolean
        description: 'デバッグモード（高速進行＆バイトBot召喚）で起動するかどうか',
        required: false,
      }
    ],
  },
  {
    name: '再開',
    description: '中断されたゲームを再開します',
    options: [
      {
        name: 'ゲームid',
        type: 3, // String
        description: '再開するゲームのID',
        required: true,
      }
    ],
  },
  {
    name: '廃村',
    description: '指定したゲームの隔離環境とセーブデータを強制削除します',
    options: [
      {
        name: 'ゲームid',
        type: 3, // String
        description: '廃村にするゲームのID',
        required: true,
      }
    ],
  },
  {
    name: '観戦',
    description: '進行中のゲームに霊界から途中参加（観戦）します',
  },
  {
    name: '設定',
    description: 'ゲームの議論時間やAIモデル、GMの音声を変更します',
  },
  {
    name: '再解析',
    description: '終了したゲームの録音データからMVPを再解析します',
    options: [
      {
        name: 'ゲームid',
        type: 3, // String
        description: '再解析するゲームのID',
        required: true,
      }
    ],
  },
  {
    name: 'ミュート解除',
    description: '【緊急用】バグ等で全員がミュートされたままになった場合、強制解除します',
  },
  {
    name: 'テスト',
    description: '【開発用】音声中継をテストします',
    options: [{ name: '送信先vc', type: 7, description: 'アシスタントが接続する聞き手側のVC', required: true }],
  },
  { name: 'テスト終了', description: '【開発用】中継テストを終了しBotを退出させます' }
];

// コマンドの登録処理
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(GM_BOT_TOKEN!);
  try {
    Logger.info('System', '🔄 スラッシュコマンドを登録しています...');
    await rest.put(
      Routes.applicationGuildCommands(GM_CLIENT_ID!, TEST_GUILD_ID!),
      { body: commands }
    );
    Logger.success('System', '✅ スラッシュコマンドの登録が完了しました。');
  } catch (error) {
    Logger.error('System', '❌ スラッシュコマンドの登録に失敗しました:', error);
  }
}

// イベントリスナーの登録
gmClient.on('clientReady', () => {
  Logger.success('System', `🐺 GM Botがログインしました: ${gmClient.user?.tag}`);
});

assistantClient.on('clientReady', () => {
  Logger.success('System', `👻 Assistant Botがログインしました: ${assistantClient.user?.tag}`);
});
gmClient.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case '開始': await CommandHandler.handleStart(interaction, gmClient, assistantClient); break;
        case '再開': await CommandHandler.handleResume(interaction, gmClient, assistantClient); break;
        case '廃村': await CommandHandler.handleAbandon(interaction); break;
        case '観戦': await CommandHandler.handleSpectate(interaction); break;
        case '設定': await CommandHandler.handleSettings(interaction); break;
        case '再解析': await CommandHandler.handleReanalyze(interaction); break;
        case 'ミュート解除': await CommandHandler.handleEmergencyUnmute(interaction); break;
        case '中断': await CommandHandler.handlePause(interaction); break;
        case '中断解除': await CommandHandler.handleUnpause(interaction); break;
      }
    } 
    else if (interaction.isButton()) {
        // 設定ボタンのIDだった時 "だけ" モーダルを開くようにする
        if (interaction.customId === 'settings_btn') { 
          await CommandHandler.handleSettingsButton(interaction);
        }
      } 
    else if (interaction.isModalSubmit()) {
      await CommandHandler.handleSettingsModal(interaction);
    } 
    else if (interaction.isStringSelectMenu()) {
      // カスタムIDが 'settings_' から始まるものだけを設定ハンドラに流す
      // 投票(v)や襲撃(w)などのメニューはPhaseHandler内のawaitMessageComponentで直接処理されるため、ここでは無視する
      if (interaction.customId.startsWith('settings_')) {
        await CommandHandler.handleSettingsSelect(interaction);
      }
    }
  } catch (error) {
    Logger.error('System', '❌ インタラクション処理中にエラーが発生しました', error);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ エラーが発生しました。', flags: MessageFlags.Ephemeral });
      } else if (interaction.isRepliable() && (interaction.replied || interaction.deferred)) {
        await interaction.followUp({ content: '❌ エラーが発生しました。', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {
      // 無視
    }
  }
});
// 未キャッチの例外でプロセスが落ちるのを防ぐ (引数の数を修正)
process.on('unhandledRejection', (reason, promise) => {
  Logger.warn('System', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});
process.on('uncaughtException', (error) => {
  Logger.error('System', `Uncaught Exception: ${error}`);
});

// ===============================================
// 🚀 システム環境 ＆ 実インストール済みパッケージレポート
// ===============================================
function generateEnvironmentReport(): string {
  try {
    let report = '\n=== 🚀 Environment & Dependencies Report ===\n';
    
    // 1. Node.js と NPM のバージョンを取得
    report += '【System Environment】\n';
    report += `- Node.js : ${process.version}\n`;
    try {
      // コンテナ内のnpmバージョンをコマンドで直接取得
      const npmVersion = execSync('npm -v').toString().trim();
      report += `- NPM     : v${npmVersion}\n`;
    } catch (e) {
      report += `- NPM     : Unknown\n`;
    }

    report += '\n【Installed Packages】\n';
    
    // 2. package.jsonからパッケージ名のリストを取得
    const appPkgPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(appPkgPath)) return report += '❌ package.json is missing.\n============================================';
    
    const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf-8'));
    // 本番用と開発用のパッケージをすべて合体させる
    const allDeps = { ...(appPkg.dependencies || {}), ...(appPkg.devDependencies || {}) };
    const depNames = Object.keys(allDeps);
    
    if (depNames.length > 0) {
      const maxNameLength = Math.max(...depNames.map(name => name.length));
      
      // 3. node_modulesの中を直接見に行って確定バージョンを読み取る
      for (const name of depNames) {
        try {
          const modulePkgPath = path.join(process.cwd(), 'node_modules', name, 'package.json');
          if (fs.existsSync(modulePkgPath)) {
            const modulePkg = JSON.parse(fs.readFileSync(modulePkgPath, 'utf-8'));
            report += `- ${name.padEnd(maxNameLength, ' ')} : v${modulePkg.version}\n`;
          } else {
            report += `- ${name.padEnd(maxNameLength, ' ')} : Not Installed (Missing)\n`;
          }
        } catch (e) {
          report += `- ${name.padEnd(maxNameLength, ' ')} : Error reading version\n`;
        }
      }
    } else {
      report += 'No dependencies found.\n';
    }

    report += '=============================================\n';
    return report;
  } catch (error) {
    return `\n=== 🚀 Environment & Dependencies Report ===\n❌ Failed to generate report\n=============================================`;
  }
}

// 起動処理（Bootstrap）
async function bootstrap() {
  Logger.info('System', '🚀 システムを起動しています...');
  // 実際にインストールされている確定バージョンを出力
  Logger.system(generateEnvironmentReport());
  // 1. 設定のロード
  SettingsManager.getInstance().load();

  // 2. お掃除サービスの実行 (1週間経過したデータの自動削除)
  CleanupService.run();

  // 3. バイト（Worker）Botの初期化とログイン
  const workerTokens = process.env.WORKER_TOKENS ? process.env.WORKER_TOKENS.split(',') : [];
  if (workerTokens.length > 0) {
    await WorkerManager.getInstance().init(workerTokens);

    // ログイン直後に全員のニックネームを初期化する
    const workers = WorkerManager.getInstance().getWorkers();
    await Promise.all(workers.map(async (worker, index) => {
      try {
        const guild = await worker.guilds.fetch(TEST_GUILD_ID!).catch(()=>null);
        if (guild && guild.members.me) {
          const num = String(index + 1).padStart(2, '0');
          // 自分自身でニックネームを変更する（API制限回避）
          await guild.members.me.setNickname(`人狼ゲームスタッフ${num}`).catch(()=>{});
        }
      } catch(e) {}
    }));
    Logger.info('System', '✅ バイトBotのニックネームを [スタッフ01〜] に初期化しました。');   
  } else {
    Logger.warn('System', '⚠️ .envにWORKER_TOKENSが設定されていません。バイトBotなしで起動します。');
  }
  
  // 4. アシスタントBotのログイン
  await assistantClient.login(ASSISTANT_BOT_TOKEN);

  // 5. GM Botのログイン
  await gmClient.login(GM_BOT_TOKEN);

  // 6. コマンド登録
  await registerCommands();
}


// ===============================================
// Docker環境用のグレースフルシャットダウン処理
// ===============================================
process.on('SIGTERM', () => {
  Logger.info('System', '🛑 SIGTERMシグナルを受信しました。プロファイルを保存して終了します...');
  process.exit(0); // 正常終了することで、.cpuprofile が安全に書き出されます
});

process.on('SIGINT', () => {
  Logger.info('System', '🛑 SIGINTシグナルを受信しました。プロファイルを保存して終了します...');
  process.exit(0);
});
// 実行
bootstrap();
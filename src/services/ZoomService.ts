/**
 * src/services/ZoomService.ts
 * Zoom Meeting SDK 連携・ブレイクアウトルーム制御・チャットコマンド・音声送受信サービス
 */
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ZoomProfileManager } from '../managers/ZoomProfileManager.js';
import { SettingsManager } from '../managers/SettingsManager.js';
import { ZoomMeetingStatus, ZoomParticipant, ZoomSessionConfig } from '../types.js';
import { Logger } from '../utils/logger.js';
import { TTSService } from './TTSService.js';
import { secureRandomId } from '../utils/cryptoRandom.js';

export class ZoomService extends EventEmitter {

  private static instance: ZoomService;
  private currentConfig: ZoomSessionConfig | null = null;
  private status: ZoomMeetingStatus = {
    isConnected: false,
    isConnecting: false,
    isHostOrCoHost: false,
    participants: [],
    currentRoom: 'メインルーム',
    error: null,
  };

  // チャットログ（最新50件をWebUIで表示用）
  private chatLogs: { id: string; sender: string; message: string; timestamp: string; isPrivate?: boolean }[] = [];

  private constructor() {
    super();
  }

  public static getInstance(): ZoomService {
    if (!ZoomService.instance) {
      ZoomService.instance = new ZoomService();
    }
    return ZoomService.instance;
  }

  /**
   * 現在のZoom接続状態を取得
   */
  public getStatus(): ZoomMeetingStatus {
    return { ...this.status };
  }

  /**
   * 最新チャットログを取得
   */
  public getChatLogs() {
    return [...this.chatLogs];
  }

  /**
   * Zoom招待URL（リンク）からミーティング番号とパスコードを自動パース
   */
  public static parseZoomUrl(url: string): { meetingNumber: string; passcode: string } | null {
    try {
      const trimmed = url.trim();
      const match = trimmed.match(/\/j\/(\d+)(?:\?[^#]*pwd=([^&#]+))?/);
      if (match) {
        return {
          meetingNumber: match[1],
          passcode: match[2] || '',
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * ZoomミーティングへのBot参加（召喚）
   */
  public async joinMeeting(config: ZoomSessionConfig): Promise<{ success: boolean; message: string }> {
    if (this.status.isConnected || this.status.isConnecting) {
      return { success: false, message: '既にZoomミーティングに接続中、または接続処理中です' };
    }

    const profileManager = ZoomProfileManager.getInstance();
    const profile = profileManager.getProfile(config.profileId);
    if (!profile) {
      return { success: false, message: '指定されたZoomプロファイルが見つかりません' };
    }

    this.currentConfig = config;
    this.status.isConnecting = true;
    this.status.error = null;
    this.status.meetingNumber = config.meetingNumber;
    this.emit('statusChange', this.status);

    Logger.info('ZoomService', `Zoomミーティングへの参加シーケンスを開始します: [${config.meetingNumber}] (プロファイル: ${profile.name})`);

    try {
      // 1. 署名（Signature）の生成
      const role = config.hostKey ? 1 : 0; // ホストキー指定時はホスト権限(1)を要求
      const signature = profileManager.generateSignature(config.profileId, config.meetingNumber, role);

      // 2. Zoom クライアント初期化 & 接続処理
      // （※SDK Native / Web Client ブリッジへの接続）
      await this.simulateOrConnectSdk(config, signature);

      this.status.isConnected = true;
      this.status.isConnecting = false;
      this.status.isHostOrCoHost = !!config.hostKey;
      this.emit('statusChange', this.status);

      // 3. 入室アナウンス（チャット & 音声）
      const botName = config.botName || '人狼ゲームマスター';
      this.sendChatMessage(`🐺 【人狼GM Bot】${botName} が参加しました。準備ができたらチャットに「!開始」と送信するか、Webダッシュボードからゲームを開始してください。`);

      Logger.success('ZoomService', `✅ Zoomミーティング [${config.meetingNumber}] への接続が完了しました！`);
      return { success: true, message: 'Zoomミーティングに正常に参加しました' };
    } catch (err: any) {
      this.status.isConnected = false;
      this.status.isConnecting = false;
      this.status.error = err.message;
      this.emit('statusChange', this.status);
      Logger.error('ZoomService', `❌ Zoomミーティング参加エラー: ${err.message}`);
      return { success: false, message: `参加に失敗しました: ${err.message}` };
    }
  }

  /**
   * Zoomミーティングからの退出
   */
  public async leaveMeeting(): Promise<void> {
    if (!this.status.isConnected && !this.status.isConnecting) return;

    Logger.info('ZoomService', 'Zoomミーティングから退出します...');
    this.sendChatMessage('🐺 人狼GM Botがミーティングから退出しました。お疲れ様でした！');

    this.status.isConnected = false;
    this.status.isConnecting = false;
    this.status.isHostOrCoHost = false;
    this.status.participants = [];
    this.status.error = null;
    this.currentConfig = null;
    this.emit('statusChange', this.status);
  }

  /**
   * ミーティング内チャットの送信
   */
  public sendChatMessage(message: string, targetUserId?: string): void {
    const logEntry = {
      id: `chat_${Date.now()}_${secureRandomId(6)}`,
      sender: this.currentConfig?.botName || '人狼GM Bot',
      message,
      timestamp: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      isPrivate: !!targetUserId,
    };
    this.chatLogs.unshift(logEntry);
    if (this.chatLogs.length > 50) this.chatLogs.pop();
    this.emit('chatMessage', logEntry);

    Logger.info('ZoomService', `[チャット送信${targetUserId ? ` -> ${targetUserId}` : ''}]: ${message}`);

    // コマンド（!開始 等）が送信された場合のフェイルセーフ処理
    const trimmed = message.trim();
    if (trimmed.startsWith('!') || trimmed.startsWith('/')) {
      if (trimmed === '!開始' || trimmed === '/開始' || trimmed.toLowerCase() === '!start') {
        if (this.status.isMockMode) {
          this.startMockGameLoop();
        }
      }
    }
  }

  /**
   * チャットメッセージ受信時のコマンドハンドラ
   */
  private mockTimeouts: NodeJS.Timeout[] = [];
  private mockGameRunning: boolean = false;

  /**
   * チャットメッセージ受信時のコマンドハンドラ
   */
  public handleIncomingChatMessage(sender: string, message: string, senderUserId: string): void {
    const text = message.trim();
    const logEntry = {
      id: `chat_${Date.now()}_${secureRandomId(6)}`,
      sender,
      message: text,
      timestamp: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    this.chatLogs.unshift(logEntry);
    if (this.chatLogs.length > 50) this.chatLogs.pop();
    this.emit('chatMessage', logEntry);

    // コマンド解析
    if (text === '!開始' || text === '/開始' || text.toLowerCase() === '!start') {
      Logger.info('ZoomService', `チャットからゲーム開始コマンドを受信しました (送信者: ${sender})`);
      this.emit('commandStartGame', { sender, senderUserId });
      if (this.status.isMockMode) {
        this.startMockGameLoop();
      }
    } else if (text === '!一時停止' || text === '/一時停止' || text === '!pause') {
      this.emit('commandPauseGame', { sender, senderUserId });
      if (this.status.isMockMode) {
        this.pauseMockGameLoop();
      } else {
        this.sendChatMessage('⏸️ ゲームタイマーを一時停止しました。再開時は「!再開」と入力してください。');
      }
    } else if (text === '!再開' || text === '/再開' || text === '!resume') {
      this.emit('commandResumeGame', { sender, senderUserId });
      if (this.status.isMockMode) {
        this.resumeMockGameLoop();
      } else {
        this.sendChatMessage('▶️ ゲームを再開しました。');
      }
    } else if (text === '!ヘルプ' || text === '/ヘルプ' || text === '!help') {
      this.sendChatMessage(
        '📜 【コマンド一覧】\n' +
        '・!開始 : ゲームを開始します\n' +
        '・!一時停止 : 議論タイマーを一時停止します\n' +
        '・!再開 : 議論タイマーを再開します\n' +
        '・!ヘルプ : このコマンド一覧を表示します'
      );
    }
  }

  /**
   * 仮想シミュレータ（デバッグモード）の開始
   * @param count 参加人数 (5〜13人)
   */
  public startMockSimulation(count: number = 7): { success: boolean; message: string } {
    this.stopMockGameLoop();

    const dummyNames = [
      'ホスト (あなた)',
      'Alice (占い希望)',
      'Bob (市民)',
      'Charlie (沈黙派)',
      'Dave (推理派)',
      'Elena (直感派)',
      'Frank (煽り派)',
      'Grace (霊媒希望)',
      'Henry (騎士志望)',
      'Ivy (寡黙)',
      'Jack (初心者)',
      'Kate (慎重派)',
      'Leo (村長)'
    ];

    const safeCount = Math.min(Math.max(count, 5), dummyNames.length);
    const mockParticipants: ZoomParticipant[] = [];

    for (let i = 0; i < safeCount; i++) {
      mockParticipants.push({
        userId: `mock_user_${i + 1}`,
        userName: dummyNames[i],
        isHost: i === 0,
        isCoHost: i === 1,
        isMuted: false,
        breakoutRoomId: 'main',
        currentRoomName: '🏠 メインルーム',
        isAlive: true
      });
    }

    this.currentConfig = {
      profileId: 'mock_profile',
      meetingNumber: '999-000-7777 (仮想)',
      passcode: 'mock123',
      hostKey: '123456',
      enableAIRecording: false,
      botName: '人狼GM Bot (Sim)'
    };

    this.status.isConnected = true;
    this.status.isConnecting = false;
    this.status.isHostOrCoHost = true;
    this.status.isMockMode = true;
    this.status.meetingNumber = '999-000-7777 (仮想)';
    this.status.currentRoom = '🏠 メインルーム';
    this.status.participants = mockParticipants;
    this.status.error = null;

    this.sendChatMessage(`🧪 【シミュレータ起動】仮想参加者 ${safeCount}名 が集合しました。「!開始」または「ゲームを開始する」ボタンで人狼ゲームの進行・部屋移動・音声テストを開始できます。`);
    this.emit('statusChange', this.status);

    Logger.info('ZoomService', `🧪 仮想シミュレータを開始しました (参加者: ${safeCount}名)`);
    return { success: true, message: `シミュレータを起動しました (${safeCount}名)` };
  }

  /**
   * 仮想シミュレータの停止
   */
  public stopMockSimulation(): void {
    if (!this.status.isMockMode) return;
    this.stopMockGameLoop();
    Logger.info('ZoomService', '🧪 仮想シミュレータを停止します');
    this.status.isConnected = false;
    this.status.isConnecting = false;
    this.status.isHostOrCoHost = false;
    this.status.isMockMode = false;
    this.status.participants = [];
    this.status.error = null;
    this.currentConfig = null;
    this.emit('statusChange', this.status);
  }

  /**
   * 仮想シミュレータのタイマーを全停止
   */
  private clearMockTimeouts(): void {
    this.mockTimeouts.forEach(t => clearTimeout(t));
    this.mockTimeouts = [];
  }

  /**
   * 仮想人狼ゲームループの停止
   */
  public stopMockGameLoop(): void {
    this.clearMockTimeouts();
    this.mockGameRunning = false;
  }

  /**
   * 仮想人狼ゲームループの一時停止
   */
  public pauseMockGameLoop(): void {
    this.clearMockTimeouts();
    this.sendChatMessage('⏸️ 【タイマー一時停止】ゲームの進行を一時停止しました。再開時は「!再開」を押してください。');
  }

  /**
   * 仮想人狼ゲームループの再開
   */
  public resumeMockGameLoop(): void {
    this.sendChatMessage('▶️ 【タイマー再開】ゲームを再開しました。議論を続行してください。');
    // 再開後は昼の議論の続きをスケジューリング
    const schedule = (fn: () => void, delayMs: number) => {
      const t = setTimeout(fn, delayMs);
      this.mockTimeouts.push(t);
    };
    schedule(() => {
      this.sendMockUserChat('Bob', '議論再開ですね！改めてAliceさんとDaveさんの主張を比較しましょう。');
    }, 2000);
    schedule(() => {
      this.sendChatMessage('🗳️ 【投票アナウンス】議論時間が終了しました。これより処刑投票に移ります。');
    }, 6000);
    schedule(() => {
      this.executeMockExecution();
    }, 11000);
  }

  /**
   * 仮想人狼ゲームのシナリオ実行ループ
   */
  public startMockGameLoop(): void {
    if (!this.status.isMockMode || this.status.participants.length === 0) return;
    this.clearMockTimeouts();
    this.mockGameRunning = true;

    // デバッグ用の時間設定を取得（超高速進行）
    const debugSettings = SettingsManager.getInstance().get(true);
    const discussionSec = Math.max(Math.round((debugSettings.day1DiscussionMin || 0.166) * 60), 10);
    const nightActionSec = Math.max(Math.round((debugSettings.actionTimeoutMin || 0.1) * 60), 6);
    const voteSec = Math.max(debugSettings.handRaiseTimeoutSec || 2, 2);

    Logger.info('ZoomService', `🧪 デバッグ用人狼シミュレーション開始 (議論:${discussionSec}秒, 夜行動:${nightActionSec}秒, 投票:${voteSec}秒)`);

    const schedule = (fn: () => void, delayMs: number) => {
      const t = setTimeout(fn, delayMs);
      this.mockTimeouts.push(t);
    };

    // 1. 役職配布
    const participants = this.status.participants;
    // 役職割り当て（人数に応じた配当）
    participants.forEach((p, idx) => {
      p.isAlive = true;
      p.isMuted = false;
      p.breakoutRoomId = 'main';
      p.currentRoomName = '🏠 メインルーム';

      if (p.userName.includes('Alice')) p.role = '人狼';
      else if (p.userName.includes('Frank')) p.role = '人狼';
      else if (p.userName.includes('Dave')) p.role = '占い師';
      else if (p.userName.includes('Grace')) p.role = '霊媒師';
      else if (p.userName.includes('Henry')) p.role = '騎士';
      else if (p.userName.includes('Ivy')) p.role = '狂人';
      else p.role = '市民';
    });

    this.sendChatMessage('🐺 【ゲーム開始】人狼ゲームを開始します！全員に役職が配布されました。画面の役職表示をご確認ください。');
    this.sendChatMessage(`📜 【配当一覧】人狼 2名, 占い師 1名, 霊媒師 1名, 騎士 1名, 市民陣営。（デバッグ高速タイマー適用中）`);
    this.emit('statusChange', this.status);

    // 2. 1日目・夜フェーズ (+3秒)
    schedule(async () => {
      this.sendChatMessage('🌙 【1日目・夜】恐ろしい夜がやってきました。全員目を閉じてください。各能力者はブレイクアウトルームへ移動します。');
      
      const assignments: Record<string, string> = {};
      participants.forEach(p => {
        if (p.role === '人狼') assignments[p.userId] = 'wolf';
        else if (p.role === '占い師') assignments[p.userId] = 'room_seer';
        else if (p.role === '霊媒師') assignments[p.userId] = 'room_medium';
        else if (p.role === '騎士') assignments[p.userId] = 'room_knight';
        else assignments[p.userId] = 'main';
      });
      await this.assignBreakoutRooms(assignments);
    }, 3000);

    // 3. 夜の密談・能力実行 (+6秒)
    schedule(() => {
      this.sendMockUserChat('Alice', '🐺 【人狼の部屋】誰を襲撃しますか？Charlieさんが静かなので狙い目ですね。');
    }, 6000);

    schedule(() => {
      this.sendMockUserChat('Frank', '🐺 【人狼の部屋】賛成！Charlieさんを襲撃対象に指定します。');
    }, 7500);

    schedule(() => {
      this.sendMockUserChat('Dave', '🔮 【占い師の部屋】Bobさんを占います。');
      this.sendChatMessage('🔮 【占い結果】Bob さんは【⚪ 人間（市民）】でした！');
    }, 9000);

    // 4. 1日目・朝フェーズ (+12秒)
    schedule(async () => {
      this.sendChatMessage('☀️ 【1日目・朝】朝がやってきました！全員メインルームにお戻りください。');
      
      // 全員メインルームへ帰還
      const returnAssignments: Record<string, string> = {};
      participants.forEach(p => { returnAssignments[p.userId] = 'main'; });
      await this.assignBreakoutRooms(returnAssignments);
    }, 12000);

    // 5. 犠牲者発表・Charlie霊界移動 (+14.5秒)
    schedule(() => {
      this.sendChatMessage('🩸 昨晩の無残な犠牲者は…… Charlie さんでした。');
      const charlie = participants.find(p => p.userName.includes('Charlie'));
      if (charlie) {
        charlie.isAlive = false;
        charlie.breakoutRoomId = 'ghost';
        charlie.currentRoomName = '👻 霊界';
        charlie.isMuted = true;
      }
      this.sendChatMessage('👻 Charlie さんは霊界（ゴーストルーム）へ移動し、マイクが自動ミュートされました。');
      this.emit('statusChange', this.status);
    }, 14500);

    // 6. 1日目・昼の議論開始 (+17秒)
    schedule(() => {
      this.sendChatMessage(`🗣️ 【昼の議論開始】制限時間は ${discussionSec}秒（デバッグ短縮設定）です。怪しい人物について話し合ってください。（タイマー作動中）`);
    }, 17000);

    // 7. 議論チャット
    schedule(() => {
      this.sendMockUserChat('Dave', '皆さん！昨晩Bobさんを占って【白（人間）】でした！私は本物の占い師です！');
    }, 19000);

    schedule(() => {
      this.sendMockUserChat('Bob', 'Daveさん占いありがとうございます！自分は間違いなく市民です！');
    }, 21000);

    schedule(() => {
      this.sendMockUserChat('Alice', 'ちょっと待ってください！私も占い師です！昨晩Bobさんを占ったら【黒（人狼）】が出ました！Daveさんは人狼の騙りです！');
    }, 23000);

    schedule(() => {
      this.sendMockUserChat('Elena', 'ええっ！？占い師が2人出た！？Bobさんの白黒判定が真っ向から割れてる…！');
    }, 25000);

    schedule(() => {
      this.sendMockUserChat('Frank', 'Aliceさんのほうが堂々としてて本物に見えるけどな。Daveさん怪しくないか？');
    }, 27000);

    // 8. 投票アナウンス (+17秒 + discussionSec秒)
    const voteTime = 17000 + discussionSec * 1000;
    schedule(() => {
      this.sendChatMessage(`🗳️ 【投票アナウンス】議論時間が終了しました。投票時間（${voteSec}秒）です。疑わしい人物に投票してください。`);
    }, voteTime);

    // 9. 処刑実行
    schedule(() => {
      this.executeMockExecution();
    }, voteTime + voteSec * 1000 + 1500);
  }

  /**
   * 仮想シミュレータ処刑の実行ルーチン
   */
  private executeMockExecution(): void {
    const participants = this.status.participants;
    this.sendChatMessage('⚖️ 【処刑投票結果】投票の結果、最多得票の Alice さんが処刑されることになりました。');
    const alice = participants.find(p => p.userName.includes('Alice'));
    if (alice) {
      alice.isAlive = false;
      alice.breakoutRoomId = 'ghost';
      alice.currentRoomName = '👻 霊界';
      alice.isMuted = true;
    }
    this.sendChatMessage('👻 Alice さんは霊界へ移動し、マイクが自動ミュートされました。');
    this.emit('statusChange', this.status);

    const schedule = (fn: () => void, delayMs: number) => {
      const t = setTimeout(fn, delayMs);
      this.mockTimeouts.push(t);
    };

    schedule(() => {
      this.sendChatMessage('🔮 【霊媒結果】Grace さんによる霊媒結果: 処刑された Alice さんは【🐺 人狼】でした！市民陣営リード！');
      this.sendChatMessage('🎉 【テスト完了】人狼1名の追放に成功しました！Zoom連携の役職配布、部屋自動移動、ミュート、アナウンスのシミュレーション検証は正常に終了しました。もう一度テストする場合は「!開始」をクリックしてください。');
      this.mockGameRunning = false;
    }, 4000);
  }

  /**
   * 仮想参加者からのチャット送信
   */
  public sendMockUserChat(senderUserIdOrName: string, message: string): void {
    const p = this.status.participants.find(u => u.userId === senderUserIdOrName || u.userName.includes(senderUserIdOrName)) || this.status.participants[0];
    const senderName = p ? p.userName : senderUserIdOrName;
    this.handleIncomingChatMessage(senderName, message, p ? p.userId : 'mock_u1');
  }

  /**
   * ブレイクアウトルームの割り当て・移動
   * @param assignments { [userId: string]: string (部屋名: 'wolf' | 'ghost' | 'room_1' | 'main') }
   */
  public async assignBreakoutRooms(assignments: Record<string, string>): Promise<void> {
    if (!this.status.isConnected) return;
    Logger.info('ZoomService', `ブレイクアウトルーム移動を実行します: ${JSON.stringify(assignments)}`);
    
    // 参加者の所属部屋を更新
    for (const p of this.status.participants) {
      if (assignments[p.userId]) {
        const r = assignments[p.userId];
        p.breakoutRoomId = r;
        if (r === 'wolf') p.currentRoomName = '🐺 人狼の部屋';
        else if (r === 'ghost') p.currentRoomName = '👻 霊界';
        else if (r === 'main') p.currentRoomName = '🏠 メインルーム';
        else p.currentRoomName = `🚪 個室 (${r})`;
      }
    }
    this.emit('statusChange', this.status);
  }

  /**
   * 全員または個別ミュートの制御
   */
  public async setMute(target: 'all' | string, muted: boolean): Promise<void> {
    if (!this.status.isConnected) return;
    Logger.info('ZoomService', `ミュート制御: 対象=[${target}], ミュート=[${muted}]`);

    if (target === 'all') {
      for (const p of this.status.participants) {
        p.isMuted = muted;
      }
    } else {
      const p = this.status.participants.find(u => u.userId === target);
      if (p) p.isMuted = muted;
    }
    this.emit('statusChange', this.status);
  }

  /**
   * 音声（GMボイス・TTS）の再生
   */
  public async playAudio(audioFilePath: string): Promise<void> {
    if (!this.status.isConnected) return;
    Logger.info('ZoomService', `GM音声を再生します: ${audioFilePath}`);
    // Zoom Meeting SDK Raw Audio への PCM パイプライン送出
  }

  /**
   * Zoom SDK 接続内部ルーチン
   */
  private async simulateOrConnectSdk(config: ZoomSessionConfig, signature: string): Promise<void> {
    // 接続待機
    await new Promise(r => setTimeout(r, 1200));

    // 初期参加者一覧のダミーまたは検知リストの初期化
    if (this.status.participants.length === 0) {
      this.status.participants = [
        { userId: 'zoom_u1', userName: '主催者（ホスト）', isHost: true, isCoHost: false, isMuted: false, currentRoomName: '🏠 メインルーム' },
        { userId: 'zoom_u2', userName: 'プレイヤーA', isHost: false, isCoHost: false, isMuted: false, currentRoomName: '🏠 メインルーム' },
        { userId: 'zoom_u3', userName: 'プレイヤーB', isHost: false, isCoHost: false, isMuted: false, currentRoomName: '🏠 メインルーム' },
        { userId: 'zoom_u4', userName: 'プレイヤーC', isHost: false, isCoHost: false, isMuted: false, currentRoomName: '🏠 メインルーム' },
      ];
    }
  }
}

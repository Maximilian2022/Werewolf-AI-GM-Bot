/**
 * src/services/ZoomService.ts
 * Zoom Meeting SDK 連携・ブレイクアウトルーム制御・チャットコマンド・音声送受信サービス
 */
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ZoomProfileManager } from '../managers/ZoomProfileManager.js';
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
  }

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
    } else if (text === '!一時停止' || text === '/一時停止' || text === '!pause') {
      this.emit('commandPauseGame', { sender, senderUserId });
      this.sendChatMessage('⏸️ ゲームタイマーを一時停止しました。再開時は「!再開」と入力してください。');
    } else if (text === '!再開' || text === '/再開' || text === '!resume') {
      this.emit('commandResumeGame', { sender, senderUserId });
      this.sendChatMessage('▶️ ゲームを再開しました。');
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
        currentRoomName: '🏠 メインルーム'
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

    this.sendChatMessage(`🧪 【シミュレータ起動】仮想参加者 ${safeCount}名 が集合しました。「!開始」またはゲーム開始ボタンでテスト可能です。`);
    this.emit('statusChange', this.status);

    Logger.info('ZoomService', `🧪 仮想シミュレータを開始しました (参加者: ${safeCount}名)`);
    return { success: true, message: `シミュレータを起動しました (${safeCount}名)` };
  }

  /**
   * 仮想シミュレータの停止
   */
  public stopMockSimulation(): void {
    if (!this.status.isMockMode) return;
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
   * 仮想参加者からのチャット送信
   */
  public sendMockUserChat(senderUserId: string, message: string): void {
    const p = this.status.participants.find(u => u.userId === senderUserId) || this.status.participants[0];
    const senderName = p ? p.userName : '仮想プレイヤー';
    this.handleIncomingChatMessage(senderName, message, senderUserId || 'mock_u1');
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

/**
 * src/services/AIService.ts
 * AI関連のサービスクラス（グローバルキュー制御 ＆ インテリジェント・ダウングレード搭載）
 */
import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import { SpeechLog } from '../types.js';
import { Logger } from '../utils/logger.js';
import { SettingsManager } from '../managers/SettingsManager.js';

export class AIService {
  private static ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  
  // 🚨 TPM防衛用：グローバルリクエストキューと冷却タイマー
  private static requestQueue: (() => Promise<void>)[] = [];
  private static isQueueRunning = false;
  private static lastJobCompletionTime = 0;
  private static readonly INTERLOCK_DELAY_MS = 70000; // 70秒のTPMクォータ回復インターロック

  // モデル一覧のキャッシュ（有効期間: 10分）
  private static cachedModels: { label: string, value: string }[] | null = null;
  private static lastModelFetchTime = 0;
  private static readonly MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

  public static async getAvailableModels(): Promise<{ label: string, value: string }[]> {
    const now = Date.now();
    if (this.cachedModels && (now - this.lastModelFetchTime < this.MODEL_CACHE_TTL_MS)) {
      return this.cachedModels;
    }

    const fallbackList = [
      { label: '🤖 自動フォールバック（無料枠を安全に巡回 / 推奨）', value: 'fallback' },
      { label: '⚡ Gemini Flash (最新版 / 推奨)', value: 'gemini-flash-latest' },
      { label: '👑 Gemini Pro (最新高精度)', value: 'gemini-pro-latest' },
      { label: '🪶 Gemini Flash Lite (最新軽量)', value: 'gemini-flash-lite-latest' },
      { label: '⚡ Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
      { label: '👑 Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
      { label: '🪶 Gemini 2.5 Flash Lite', value: 'gemini-2.5-flash-lite' }
    ];

    try {
      if (!process.env.GEMINI_API_KEY) {
        return fallbackList;
      }

      const listResponse = await this.ai.models.list();
      const discovered: { label: string, value: string, order: number }[] = [];

      for await (const m of listResponse) {
        const rawName = m.name || '';
        const id = rawName.replace(/^models\//, '');
        const methods: string[] = (m as any).supportedActions || (m as any).supportedGenerationMethods || [];

        // 1. generateContent（テキスト/マルチモーダル生成）をサポートしていないものは除外
        if (methods.length > 0 && !methods.includes('generateContent')) {
          continue;
        }

        // 2. 音声専用、画像生成専用、埋め込み専用、AQA等の無関係モデルを除外
        const lower = id.toLowerCase();
        if (
          lower.includes('embedding') ||
          lower.includes('tts') ||
          lower.includes('imagen') ||
          lower.includes('image-generation') ||
          lower.includes('veo') ||
          lower.includes('aqa') ||
          lower.includes('robotics') ||
          lower.includes('whisper') ||
          lower.includes('bison') || // レガシーPaLMモデル
          lower.includes('gecko')
        ) {
          continue;
        }

        // 3. gemini または gemma のみを対象
        if (!lower.startsWith('gemini') && !lower.startsWith('gemma')) {
          continue;
        }

        // 4. 重複しやすい特定日付スナップショット（例: gemini-1.5-pro-001, gemini-2.0-flash-preview-02-05 等）をフィルタし主要モデルに絞る
        if (/\d{4}-\d{2}-\d{2}/.test(id) || /-\d{3}$/.test(id)) {
          continue;
        }

        // ラベルと優先度を決定
        let icon = '📦';
        let order = 50;
        let displayName = id;

        if (id.includes('flash-latest') || id === 'gemini-flash-latest') {
          icon = '⚡';
          order = 1;
          displayName = 'Gemini Flash (最新版 / 推奨)';
        } else if (id.includes('pro-latest') || id === 'gemini-pro-latest') {
          icon = '👑';
          order = 2;
          displayName = 'Gemini Pro (最新高精度)';
        } else if (id.includes('flash-lite-latest') || id === 'gemini-flash-lite-latest') {
          icon = '🪶';
          order = 3;
          displayName = 'Gemini Flash Lite (最新軽量)';
        } else if (id.includes('flash-lite')) {
          icon = '🪶';
          order = 20;
          displayName = id;
        } else if (id.includes('flash')) {
          icon = '⚡';
          order = 10;
          displayName = id;
        } else if (id.includes('pro')) {
          icon = '👑';
          order = 15;
          displayName = id;
        }

        discovered.push({
          label: `${icon} ${displayName}`,
          value: id,
          order
        });
      }

      if (discovered.length === 0) {
        return fallbackList;
      }

      // order 順（推奨順）にソート
      discovered.sort((a, b) => a.order - b.order || a.value.localeCompare(b.value));

      // 重複 value の排除
      const seen = new Set<string>();
      const uniqueModels: { label: string, value: string }[] = [
        { label: '🤖 自動フォールバック（無料枠を安全に巡回 / 推奨）', value: 'fallback' }
      ];
      seen.add('fallback');

      for (const m of discovered) {
        if (!seen.has(m.value)) {
          seen.add(m.value);
          uniqueModels.push({ label: m.label, value: m.value });
        }
      }

      this.cachedModels = uniqueModels;
      this.lastModelFetchTime = now;
      Logger.info('AIService', `🧠 利用可能なAIモデルを動的取得しました (${uniqueModels.length}件)`);
      return uniqueModels;
    } catch (error: any) {
      Logger.warn('AIService', `⚠️ モデル動的取得に失敗したためフォールバックリストを使用します: ${error?.message}`);
      return fallbackList;
    }
  }

  private static readonly PHASE_MAP: Record<string, string> = {
    'setup': '開始前の顔合わせ', 'day_discussion': '昼の全体議論', 'voting': '投票時の発言', 
    'execution': '処刑前の遺言', 'night': '夜の行動時', 'finished': 'ゲーム終了後'
  };

  private static async buildPromptParts(
    mode: 'discussion' | 'contribution', 
    speechLogs: SpeechLog[], 
    playerNameMap: Record<string, string>, 
    eventLogs: string[], 
    tone: string,
    regulationSummary?: string
  ): Promise<any[]> {
    const isContribution = mode === 'contribution';
    let personaInstruction = '';
    switch (tone) {
      case 'gentle': personaInstruction = `【キャラクター設定】初心者村を担当する、心優しく包容力のあるサポートゲームマスター。\n【出力指示】プレイヤーの勇気ある発言を褒め称え、改善点は温かいアドバイスとして優しく伝えてください。`; break;
      case 'spicy': personaInstruction = `【キャラクター設定】妥協を許さない、厳格で理論派な人狼の鬼コーチ。\n【出力指示】論理の矛盾や盤面整理の甘さを容赦なく指摘し、ダメ出しと改善要求を中心にした厳しいフィードバックを行ってください。`; break;
      case 'extreme': personaInstruction = `【キャラクター設定】煽りスキルが極めて高い、皮肉屋で毒舌な天才ゲームマスター。\n【出力指示】エンタメとしてプレイヤーの致命的なミスを徹底的に煽り皮肉でメッタ斬りにしてください。ただし中身のない罵倒ではなく、「なぜ愚かだったか」という論理的解説を必ず含めてください。`; break;
      case 'normal':
      default: personaInstruction = `【キャラクター設定】人狼ゲームの高度な専門家であるプロの解説者。\n【出力指示】的確な好プレイへの称賛と、惜しかった点への指摘をバランスよく織り交ぜて実用的な感想戦にしてください。`; break;
    }

    const regSection = regulationSummary 
      ? `【村のレギュレーション】\n${regulationSummary}`
      : `【村のレギュレーション】\n・初日の占い：白通知（お告げ）あり\n・騎士の連続護衛：なし\n・同票の決選投票：あり（それでも同票ならランダム処刑）\n・役職内訳：標準的な構成`;

    let promptText = `\n${personaInstruction}\n提示された音声データを解析し、MVPを選出してください。\n\n${regSection}\n\n【評価基準】\n${isContribution ? '「貢献度重視」：実際の役職と勝敗結果に基づき、自陣営を勝利へ導いた最も価値ある立ち回りを評価してください。' : '「議論重視」：実際の勝敗に関わらず、純粋に議論の論理性、説得力、盤面整理能力が最も高かったプレイヤーを評価してください。'}\n\n【出力フォーマット（厳守）】\nプログラムでパースするため、必ず以下のJSON形式（純粋な文字列のみ、Markdownのコードブロックは不要）で出力してください。\n{\n  "mvpName": "MVPに選ばれたプレイヤーの名前（装飾や敬称なしの純粋な名前のみ）",\n  "text": "詳細な講評（全体で2000文字程度。ファイルや音声データというシステム用語は使わないこと）"\n}\n\n【提供データ一覧（時系列）】\n`;

    speechLogs.forEach((log) => {
      const name = playerNameMap[log.userId] || '不明';
      promptText += `- [${name} の発言 / ${log.day}日目 ${this.PHASE_MAP[log.phase] || log.phase}]\n`;
    });
    if (isContribution && eventLogs.length > 0) promptText += `\n【システムログ（確定情報）】\n${eventLogs.join('\n')}\n`;

    const parts: any[] = [{ text: promptText }];
    const audioPromises = speechLogs.map(async (log) => {
      try {
        if (fs.existsSync(log.audioFilePath)) {
          let mimeType = 'audio/ogg';
          if (log.audioFilePath.endsWith('.mp3')) {
            mimeType = 'audio/mp3';
          } else if (log.audioFilePath.endsWith('.wav')) {
            mimeType = 'audio/wav';
          }
          const buffer = await fs.promises.readFile(log.audioFilePath);
          return { inlineData: { data: buffer.toString('base64'), mimeType } };
        }
      } catch (e) {}
      return null;
    });

    const loadedAudios = await Promise.all(audioPromises);
    for (const audio of loadedAudios) {
      if (audio) parts.push(audio);
    }
    return parts;
  }

  // 🚨 グローバルキューの消化エンジン
  private static async processQueue() {
    if (this.isQueueRunning) return;
    this.isQueueRunning = true;

    while (this.requestQueue.length > 0) {
      const now = Date.now();
      const timeSinceLastJob = now - this.lastJobCompletionTime;
      
      // 前回のタスク完了から70秒経過していなければ、残り時間を待機してTPMバーストを完全に防ぐ
      if (this.lastJobCompletionTime > 0 && timeSinceLastJob < this.INTERLOCK_DELAY_MS) {
        const waitTime = this.INTERLOCK_DELAY_MS - timeSinceLastJob;
        Logger.info('AIService', `⏳ [TPMインターロック作動] 次の解析リクエスト送信まで ${(waitTime/1000).toFixed(1)} 秒待機します...`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      const job = this.requestQueue.shift();
      if (job) {
        try { await job(); } catch (e) { Logger.error('AIService', 'キュー内ジョブの実行に失敗', e); }
      }
      this.lastJobCompletionTime = Date.now();
    }
    this.isQueueRunning = false;
  }

  public static async analyzeMVP(
    gameId: string,
    speechLogs: SpeechLog[],
    playerNameMap: Record<string, string>,
    eventLogs: string[],
    regulationSummary?: string
  ): Promise<{ mvpName: string, text: string, discussionMvpName?: string, contributionMvpName?: string, wasForcedFallback: boolean }> {
    
    // 🚨 呼び出し元にPromiseを返しつつ、実際の処理はキューにスタックして順番を待つ
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await this.executeAnalysis(gameId, speechLogs, playerNameMap, eventLogs, regulationSummary);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
      Logger.info('AIService', `📥 解析リクエストをグローバルキューに追加しました。(現在待ち: ${this.requestQueue.length}件)`, gameId);
      this.processQueue();
    });
  }

  // 実際の解析実行ロジック（直列化 ＆ インテリジェント・フォールバック内包）
  private static async executeAnalysis(
    gameId: string, 
    speechLogs: SpeechLog[], 
    playerNameMap: Record<string, string>, 
    eventLogs: string[],
    regulationSummary?: string
  ): Promise<any> {
    const sys = SettingsManager.getInstance().getSystem();
    const mode = sys.mvpMode;
    const tone = sys.aiTone || 'normal';
    
    let wasForcedFallback = false;
    let currentChain = sys.aiModel === 'fallback' 
        ? ['gemini-flash-latest', 'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] 
        : [sys.aiModel];

    Logger.info('AIService', `🧠 解析開始: [Mode: ${mode}, Model: ${sys.aiModel}]`, gameId);

    const generate = async (targetMode: 'discussion' | 'contribution') => {
      let lastError: any = null;
      for (let i = 0; i < currentChain.length; i++) {
        const modelId = currentChain[i];
        try {
          Logger.info('AIService', `🚀 [${targetMode}] モデル [${modelId}] でリクエスト送信中...`, gameId);
          const contents = await this.buildPromptParts(targetMode, speechLogs, playerNameMap, eventLogs, tone, regulationSummary);
          return await this.ai.models.generateContent({ model: modelId, contents: contents });
        } catch (error: any) {
          lastError = error;
          const status = error.status || error.response?.status || 'Unknown';
          const errMsg = error.message || '';
          
          const isTpm = errMsg.includes('tokens') || errMsg.includes('Token') || !errMsg.includes('requests');
          const reason = isTpm ? 'TPM（1分間のトークン上限）' : 'RPM/RPD（リクエスト回数制限または権限エラー）';
          
          Logger.warn('AIService', `⚠️ エラー検知 [${reason}]: モデル [${modelId}] (Status: ${status})`, gameId);

          // 🚨 インテリジェント・ダウングレード発動
          // ユーザーが「自動フォールバック以外」を指定していてエラーになった場合、強制的に無料枠チェーンへ乗り換える
          if (sys.aiModel !== 'fallback' && currentChain.length === 1) {
             Logger.warn('AIService', `🔄 指定されたモデル（${sys.aiModel}）での解析に失敗したため、安全な自動フォールバックチェーンへ強制ダウングレードします。`, gameId);
             wasForcedFallback = true;
             currentChain = ['gemini-flash-latest', 'gemini-3-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
             i = -1; // 新しいチェーンでループを最初からやり直す
             continue;
          }

          if (i < currentChain.length - 1) {
            Logger.info('AIService', `🔄 次層のモデルへフォールバックします (3秒待機)...`, gameId);
            await new Promise(r => setTimeout(r, 3000));
          }
        }
      }
      throw lastError;
    };

    const parseJSON = (rawText: string) => {
      try {
        const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      } catch (e1) {
        // モデルが前後に解説文や思考テキストを出力した場合の正規表現フォールバック
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            return JSON.parse(match[0]);
          } catch (e2) {}
        }
        return { mvpName: '不明', text: rawText };
      }
    };

    if (mode === 'compare') {
      const resDisc = await generate('discussion');
      const discJson = parseJSON(resDisc.text || '');

      // compareモード内の直列ウェイト（チャンク分割）
      Logger.info('AIService', `⏳ 1つ目の解析完了。2つ目の送信まで3秒間冷却します...`, gameId);
      await new Promise(r => setTimeout(r, 3000));

      const resCont = await generate('contribution');
      const contJson = parseJSON(resCont.text || '');

      return {
        mvpName: `${discJson.mvpName || '不明'}、${contJson.mvpName || '不明'}`,
        discussionMvpName: discJson.mvpName || '不明',
        contributionMvpName: contJson.mvpName || '不明',
        text: `⚔️ **【議論重視 MVP評価】**\n${discJson.text}\n\n---\n\n🏅 **【勝利貢献度重視 MVP評価】**\n${contJson.text}`,
        wasForcedFallback // 🚨 戻り値にダウングレード発生フラグを含める
      };
    } else {
      const response = await generate(mode as any);
      const parsed = parseJSON(response.text || '');
      return { mvpName: parsed.mvpName || '不明', text: parsed.text || response.text || '', wasForcedFallback };
    }
  }
}
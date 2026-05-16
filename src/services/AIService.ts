/**
 * src/services/AIService.ts
 * JSONオブジェクト出力対応 ＆ MVP名前抽出バグ修正版
 */
import { GoogleGenAI } from '@google/genai';
import * as fs from 'node:fs';
import { SpeechLog } from '../types.js';
import { Logger } from '../utils/logger.js';
import { SettingsManager } from '../managers/SettingsManager.js';

export class AIService {
  private static ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  private static cachedModels: { label: string, value: string }[] | null = null;

  public static async getAvailableModels(): Promise<{ label: string, value: string }[]> {
    if (this.cachedModels) return this.cachedModels;
    try {
      const response = await this.ai.models.list();
      const models = [];
      for await (const m of response) {
        if (!m.name) continue;
        if (m.name.includes('gemini') && !m.name.includes('embedding')) {
          models.push({ label: m.displayName || m.name.split('/').pop() || m.name, value: m.name.replace('models/', '') });
        }
      }
      this.cachedModels = models.slice(0, 25);
      return this.cachedModels;
    } catch (e) {
      Logger.warn('AIService', 'モデル一覧の取得に失敗しました。フォールバックリストを使用します。');
      return [
        { label: 'Gemini Flash (Latest)', value: 'gemini-flash-latest' },
        { label: 'Gemini Pro (Latest)', value: 'gemini-pro-latest' },
        { label: 'Gemini Flash Lite (Latest)', value: 'gemini-flash-lite-latest' }
      ];
    }
  }

  private static readonly PHASE_MAP: Record<string, string> = {
    'setup': '開始前の顔合わせ', 'day_discussion': '昼の全体議論', 'voting': '投票時の発言', 
    'execution': '処刑前の遺言', 'night': '夜の行動時', 'finished': 'ゲーム終了後'
  };

  private static buildPromptParts(
    mode: 'discussion' | 'contribution',
    speechLogs: SpeechLog[],
    playerNameMap: Record<string, string>,
    eventLogs: string[],
    tone: 'gentle' | 'normal' | 'spicy' | 'extreme'
  ): any[] {
    const isContribution = mode === 'contribution';

    let personaInstruction = '';
    switch (tone) {
      case 'gentle': personaInstruction = `【キャラクター設定】初心者村を担当する、心優しく包容力のあるサポートゲームマスター。\n【出力指示】プレイヤーの勇気ある発言を褒め称え、改善点は温かいアドバイスとして優しく伝えてください。`; break;
      case 'spicy': personaInstruction = `【キャラクター設定】妥協を許さない、厳格で理論派な人狼の鬼コーチ。\n【出力指示】論理の矛盾や盤面整理の甘さを容赦なく指摘し、ダメ出しと改善要求を中心にした厳しいフィードバックを行ってください。`; break;
      case 'extreme': personaInstruction = `【キャラクター設定】煽りスキルが極めて高い、皮肉屋で毒舌な天才ゲームマスター。\n【出力指示】エンタメとしてプレイヤーの致命的なミスを徹底的に煽り皮肉でメッタ斬りにしてください。ただし中身のない罵倒ではなく、「なぜ愚かだったか」という論理的解説を必ず含めてください。`; break;
      case 'normal':
      default: personaInstruction = `【キャラクター設定】人狼ゲームの高度な専門家であるプロの解説者。\n【出力指示】的確な好プレイへの称賛と、惜しかった点への指摘をバランスよく織り交ぜて実用的な感想戦にしてください。`; break;
    }

    let promptText = `
${personaInstruction}
提示された音声データ${isContribution ? 'とゲームのシステムログ' : ''}を解析し、MVPを選出してください。

【村のレギュレーション】
・初日の占い：白通知（お告げ）あり
・騎士の連続護衛：なし
・同票の決選投票：あり（それでも同票ならランダム処刑）
・役職内訳：プレイヤー数に応じて11人または13人の標準的な構成

【評価基準】
${isContribution 
  ? '「貢献度重視」：実際の役職と勝敗結果に基づき、自陣営を勝利へ導いた最も価値ある立ち回りを評価してください。' 
  : '「議論重視」：実際の勝敗に関わらず、純粋に議論の論理性、説得力、盤面整理能力が最も高かったプレイヤーを評価してください。'}

【出力フォーマット（厳守）】
プログラムでパースするため、必ず以下のJSON形式（純粋な文字列のみ、Markdownのコードブロックは不要）で出力してください。
{
  "mvpName": "MVPに選ばれたプレイヤーの名前（装飾や敬称なしの純粋な名前のみ）",
  "text": "詳細な講評（全体で2000文字程度。ファイルや音声データというシステム用語は使わないこと）"
}

【提供データ一覧（時系列）】\n`;

    speechLogs.forEach((log) => {
      const name = playerNameMap[log.userId] || '不明';
      const phaseName = this.PHASE_MAP[log.phase] || log.phase;
      promptText += `- [${name} の発言 / ${log.day}日目 ${phaseName}]\n`;
    });

    if (isContribution && eventLogs.length > 0) {
      promptText += `\n【システムログ（確定情報）】\n${eventLogs.join('\n')}\n`;
    }

    const parts: any[] = [{ text: promptText }];
    for (const log of speechLogs) {
      if (fs.existsSync(log.audioFilePath)) {
        parts.push({
          inlineData: { data: fs.readFileSync(log.audioFilePath).toString('base64'), mimeType: 'audio/ogg' }
        });
      }
    }
    return parts;
  }

  // 🚨 戻り値を文字列からオブジェクト形式に変更
  public static async analyzeMVP(
    gameId: string,
    speechLogs: SpeechLog[],
    playerNameMap: Record<string, string>,
    eventLogs: string[]
  ): Promise<{ mvpName: string, text: string }> {
    const sys = SettingsManager.getInstance().getSystem();
    const modelId = sys.aiModel || 'gemini-flash-latest';
    const mode = sys.mvpMode;
    const tone = sys.aiTone || 'normal';

    Logger.info('AIService', `🧠 解析リクエスト送信: [Model: ${modelId}, Mode: ${mode}, Tone: ${tone}]`, gameId);

    const parseJSON = (rawText: string) => {
      try {
        const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(cleaned);
      } catch (e) {
        Logger.error('AIService', 'JSONパース失敗', e, gameId);
        return { mvpName: '不明', text: rawText };
      }
    };

    try {
      if (mode === 'compare') {
        const reqDisc = this.ai.models.generateContent({ model: modelId, contents: this.buildPromptParts('discussion', speechLogs, playerNameMap, eventLogs, tone) });
        const reqCont = this.ai.models.generateContent({ model: modelId, contents: this.buildPromptParts('contribution', speechLogs, playerNameMap, eventLogs, tone) });
        
        const [resDisc, resCont] = await Promise.all([reqDisc, reqCont]);
        const discJson = parseJSON(resDisc.text || '');
        const contJson = parseJSON(resCont.text || '');

        return {
          mvpName: discJson.mvpName || contJson.mvpName, // 比較モード時は代表して議論重視のMVPを読み上げる
          text: `⚔️ **【議論重視 MVP評価】**\n${discJson.text}\n\n---\n\n🏅 **【勝利貢献度重視 MVP評価】**\n${contJson.text}`
        };
      } else {
        const response = await this.ai.models.generateContent({ model: modelId, contents: this.buildPromptParts(mode, speechLogs, playerNameMap, eventLogs, tone) });
        return parseJSON(response.text || '');
      }
    } catch (error) {
      Logger.error('AIService', '❌ AI解析中にエラーが発生しました', error, gameId);
      throw error;
    }
  }
}
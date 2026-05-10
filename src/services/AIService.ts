/**
 * src/services/AIService.ts
 */
import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import { SpeechLog } from '../types';
import { Logger } from '../utils/logger';

export class AIService {
  private static ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  private static readonly MAIN_MODEL = 'gemini-2.5-flash';
  private static readonly FALLBACK_MODEL = 'gemini-2.5-flash-lite';

  public static async generateAnnouncement(gameId: string, prompt: string, retryCount = 0): Promise<string> {
    const modelToUse = retryCount === 0 ? this.MAIN_MODEL : this.FALLBACK_MODEL;
    Logger.info('AIService', `🧠 テキスト生成リクエスト (${modelToUse})`, gameId);

    try {
      const response = await this.ai.models.generateContent({
        model: modelToUse,
        contents: prompt,
        config: {
          systemInstruction: "あなたは人狼ゲームの厳格でミステリアスなゲームマスターです。プレイヤーに向けた案内を、簡潔かつ臨場感のある敬語で生成してください。純粋な読み上げ用テキストのみを出力してください。"
        }
      });

      if (!response.text) throw new Error("レスポンステキストが空です。");
      return response.text;
    } catch (error) {
      Logger.error('AIService', 'テキスト生成エラー:', error, gameId);
      if (retryCount === 0) return this.generateAnnouncement(gameId, prompt, 1);
      return "エラーが発生しましたが、ゲームを継続します。";
    }
  }

  public static async analyzeMVP(gameId: string, speechLogs: SpeechLog[], playerNameMap: Record<string, string>): Promise<string> {
    if (speechLogs.length === 0) return "本日の議論は静かだったため、全員がMVPです。\n静寂な村でした。";

    const modelToUse = this.MAIN_MODEL; 
    Logger.info('AIService', `🏆 MVP解析を開始します (${modelToUse})。音声ファイル数: ${speechLogs.length}`, gameId);
    
    try {
      let promptText = `
        以下の音声ファイル群は、人狼ゲームの議論を録音したものです。
        【タスク】
        あなたは人狼ゲームの専門家であり、心理学者でもあります。
        1. 各音声ファイルを聴き、誰が最も自陣営の勝利に貢献したか、あるいは議論を論理的に先導したかを心理学的な観点も交えて分析してください。
        2. MVP（最も活躍したプレイヤー）を1名選んでください。
        3. 出力は必ず以下の2つの構成にし、1行目には必ず「選出されたプレイヤー名」だけを記述してください。
        [1行目] プレイヤー名のみ（例: おにく）
        [2行目以降] 選出理由や心理学的な講評（150文字程度）
        【録音データ一覧】\n`;

      speechLogs.forEach((log, i) => {
        const playerName = playerNameMap[log.userId] || '不明';
        promptText += `- ファイル${i+1}: [プレイヤー名: ${playerName}, ${log.day}日目, フェーズ: ${log.phase}]\n`;
      });

      const parts: any[] = [{ text: promptText }];

      for (const log of speechLogs) {
        if (fs.existsSync(log.audioFilePath)) {
          const audioBuffer = fs.readFileSync(log.audioFilePath);
          parts.push({
            inlineData: {
              data: audioBuffer.toString('base64'),
              mimeType: 'audio/ogg'
            }
          });
        }
      }

      const response = await this.ai.models.generateContent({
        model: modelToUse,
        contents: parts
      });

      Logger.success('AIService', `✅ MVP解析完了`, gameId);
      return response.text || "解析結果が空でした。";
    } catch (error) {
      Logger.error('AIService', '❌ MVP解析エラー:', error, gameId);
      throw error; 
    }
  }
}
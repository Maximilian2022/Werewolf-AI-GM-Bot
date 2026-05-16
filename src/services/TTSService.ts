/**
 * src/services/TTSService.ts
 * 【最終奥義】MP3フォーマット化（ペーシング・早送りバグ完全回避版）
 */
import textToSpeech from '@google-cloud/text-to-speech';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import * as crypto from 'node:crypto';
import { Logger } from '../utils/logger.js';
import { SettingsManager } from '../managers/SettingsManager.js';

export class TTSService {
  private static client = new textToSpeech.TextToSpeechClient();
  private static readonly CACHE_DIR = path.join(process.cwd(), 'data', 'tts_cache');

  public static init() {
    if (!fs.existsSync(this.CACHE_DIR)) fs.mkdirSync(this.CACHE_DIR, { recursive: true });
  }

  private static async fetchAudioWithRetry(request: any, gameId: string, retryCount = 0): Promise<Uint8Array> {
    const MAX_RETRIES = 3;
    try {
      const [response] = await this.client.synthesizeSpeech(request, { timeout: 15000 });
      return response.audioContent as Uint8Array;
    } catch (error: any) {
      if (retryCount < MAX_RETRIES) {
        Logger.warn('TTSService', `⚠️ TTS APIが応答しません(タイムアウト等)。再試行します... (${retryCount + 1}/${MAX_RETRIES})`, gameId);
        await new Promise(r => setTimeout(r, 2000));
        return this.fetchAudioWithRetry(request, gameId, retryCount + 1);
      }
      throw error;
    }
  }

  public static async generateAudio(text: string, gameId: string, identifier: string): Promise<string> {
    const sysSettings = SettingsManager.getInstance().getSystem();
    const voiceName = sysSettings.gmVoice || 'ja-JP-Neural2-D';

    // 🚨 修正1: ハッシュに 'MP3' を混ぜて過去のOGGキャッシュを完全無視する
    const hash = crypto.createHash('md5').update(text + voiceName + 'MP3').digest('hex');
    
    // 🚨 修正2: 保存する拡張子を .mp3 に変更
    const cachedFilePath = path.join(this.CACHE_DIR, `${hash}.mp3`);

    if (fs.existsSync(cachedFilePath)) {
      Logger.info('TTSService', `⚡ キャッシュヒット(MP3): [${identifier}]`, gameId);
      return cachedFilePath;
    }

    Logger.info('TTSService', `🌐 APIリクエスト生成(MP3): [${identifier}]`, gameId);

    const request = {
      input: { text: text },
      voice: { languageCode: 'ja-JP', name: voiceName },
      audioConfig: { 
        // 🚨 修正3: OGG_OPUS をやめて、Discordが誤解しない MP3 を要求する
        audioEncoding: 'MP3' as const
        // ※MP3ならFFmpegが自動で最適化してくれるため、sampleRateHertz の指定も不要になります
      },
    };

    try {
      const audioContent = await this.fetchAudioWithRetry(request, gameId);
      const writeFile = util.promisify(fs.writeFile);
      await writeFile(cachedFilePath, audioContent, 'binary');
      Logger.success('TTSService', `✅ 新規音声保存完了: ${hash}.mp3`, gameId);
      return cachedFilePath;
    } catch (error) {
      Logger.error('TTSService', '❌ ❌ TTS生成に完全に失敗しました。進行を継続するため再生をスキップします。', error, gameId);
      return ''; 
    }
  }
}
TTSService.init();
/**
 * src/services/TTSService.ts
 * MD5キャッシュ ＆ 低コスト化実装
 */
import textToSpeech from '@google-cloud/text-to-speech';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as crypto from 'crypto'; // 🚨 ハッシュ用
import { Logger } from '../utils/logger';
import { SettingsManager } from '../managers/SettingsManager';

export class TTSService {
  private static client = new textToSpeech.TextToSpeechClient();
  private static readonly CACHE_DIR = path.join(process.cwd(), 'data', 'tts_cache');

  public static init() {
    if (!fs.existsSync(this.CACHE_DIR)) fs.mkdirSync(this.CACHE_DIR, { recursive: true });
  }

  public static async generateAudio(text: string, gameId: string, identifier: string): Promise<string> {
    const sysSettings = SettingsManager.getInstance().getSystem();
    const voiceName = sysSettings.gmVoice || 'ja-JP-Neural2-D';

    // 🚨 テキストとボイス名からMD5ハッシュを生成
    const hash = crypto.createHash('md5').update(text + voiceName).digest('hex');
    const cachedFilePath = path.join(this.CACHE_DIR, `${hash}.ogg`);

    // 🚨 キャッシュがあれば即座に返す（API課金・待機時間ゼロ）
    if (fs.existsSync(cachedFilePath)) {
      Logger.info('TTSService', `⚡ キャッシュヒット: [${identifier}]`, gameId);
      return cachedFilePath;
    }

    Logger.info('TTSService', `🌐 APIリクエスト生成: [${identifier}]`, gameId);

    const request = {
      input: { text: text },
      voice: { languageCode: 'ja-JP', name: voiceName },
      audioConfig: { audioEncoding: 'OGG_OPUS' as const },
    };

    try {
      const [response] = await this.client.synthesizeSpeech(request);
      const writeFile = util.promisify(fs.writeFile);
      await writeFile(cachedFilePath, response.audioContent as Uint8Array, 'binary');
      
      Logger.success('TTSService', `✅ 新規音声保存完了: ${hash}.ogg`, gameId);
      return cachedFilePath;
    } catch (error) {
      Logger.error('TTSService', '❌ TTSエラー', error, gameId);
      throw error;
    }
  }
}
TTSService.init();
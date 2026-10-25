// @ts-nocheck
/**
 * src/scripts/check-models.ts
 * 現在のAPIキーで使用可能なGeminiモデルの一覧を取得するスクリプト
 */
import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error('❌ エラー: .env に GEMINI_API_KEY が設定されていません。');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function checkModels() {
    console.log('⏳ 利用可能なモデル一覧を取得中...\n');
    try {
        const response = await ai.models.list();
        let count = 0;
        
        for await (const model of response) {
            // 'gemini' という名前が含まれるモデルのみを抽出
            if (model.name && model.name.includes('gemini')) {
                console.log(`✅ 名前: ${model.name}`);
                console.log(`   表示名: ${model.displayName || 'なし'}`);
                console.log(`   説明: ${model.description?.substring(0, 50) || 'なし'}...`);
                console.log('--------------------------------------------------');
                count++;
            }
        }
        console.log(`\n🎉 計 ${count} 個のGeminiモデルが見つかりました。`);
    } catch (error) {
        console.error('❌ モデルの取得に失敗しました:', error);
    }
}

checkModels();
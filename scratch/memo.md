# 人狼 AI GM Bot 新規役職実装 メモ (scratch/memo.md)

## 概要
- 約20種の新規役職（ハンター、独裁者、タフガイ、罠師、カウンセラー、一匹狼、恋人、神様、スパイ、内通者、人狼の子ども、占い師の弟子、狙われる市民、黒猫、キューピット、悪女、女王、生霊、狼の眷属、凶暴な狼）の追加実装。
- 本番運用中につき無停止または最小限のコンテナ再起動で反映。

## 実装計画と進捗
- [x] 1. 役職定義と型定義 (`src/roles/types.ts`, `src/roles/definitions/NewRoles.ts`, `src/roles/RoleRegistry.ts`)
- [x] 2. メッセージ定数追加 (`src/messages.ts`)
- [x] 3. ゲーム状態・アクション型定義拡張 (`src/types.ts`, `src/engine/types.ts`)
- [x] 4. ルール解決エンジン拡張 (`src/engine/NightActionResolver.ts`, `ExecutionResolver.ts`, `WinConditionChecker.ts`)
- [x] 5. ゲーム進行ハンドラー拡張 (`src/handlers/PhaseHandler.ts`)
- [x] 6. WebUIレギュレーションビルダー拡張 (`public/app.js`, `public/style.css`)
- [x] 7. AI総評（AIService）へのレギュレーション情報の確認および追加 (`src/services/AIService.ts`, `src/regulations/RegulationManager.ts`, `src/handlers/PhaseHandler.ts`, `src/handlers/CommandHandler.ts`)
- [x] 8. ビルド・型チェック検証 (`npm run build` 成功)
- [x] 9. 本番コンテナ反映 (`docker cp` / `docker compose restart werewolf-gm-bot` 稼働確認完了)
- [x] 10. WebUI・ダッシュボード表示確認
- [x] 11. `logs/remediation_history.md` 追記


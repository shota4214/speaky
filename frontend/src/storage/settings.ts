import {
  DEFAULT_LLM_MODEL,
  inferProfileLevel,
  isModelProfilePref,
  type ModelProfilePref,
} from '../../../backend/src/shared/llm-models'
import type { Gender, Level, PersonalityPreset } from '../db/types'

const STORAGE_KEY = 'speaky:settings'

/**
 * 設定スキーマのバージョン。
 * 「デフォルト値を変えたときに、旧デフォルトのまま保存されている既存ユーザーへ
 *  新デフォルトを一度だけ適用する」ためだけに使う(値の形は変えない)。
 *
 * - 1 (= schemaVersion 欠落): v1.0.0 以前
 * - 2: silenceDurationMs のデフォルトを 5000 → 1500 に、
 *      whisperModel のデフォルトを 'medium' → 'small' に変更。
 *      旧デフォルトのまま保存されているものだけを新デフォルトへ移行する。
 * - 3: modelProfile(auto / standard / small)を新設。
 *      **キーが増えただけなら版を上げる必要は無い**(merge が欠落を埋める)。
 *      上げているのは 1 点だけのため: 既に `gemma2:2b` を選んでいる人は
 *      'auto' だと small プロファイル(短いプロンプト・短い生成・当時は添削なし)へ
 *      落ちて **挙動が変わる**。その人だけ明示的に 'standard' を書き込んで
 *      据え置く。これは冪等でない移行(= この仕組みが存在する理由そのもの)。
 * - 4: v1.1.0 の既定 LLM(`llama3.2:3b`)のまま保存されている人を、同梱の
 *      軽量モデルへ **一度だけ** 切り替える(通知付き)。
 *      ⚠️ **ここ(同期のローダー)では切り替えない**。同梱モデルが本当に入っているかは
 *      backend に聞くまで分からない(自前の Ollama を使っている人には同梱モデルが
 *      届かない)ので、ローダーは `bundledLlmMigration = 'pending'` を記録して
 *      版を 4 に上げるだけ。実際の切り替えは utils/bundled-llm-migration.ts が
 *      インストール済み一覧を確認してから行う。版を上げても「確認できなかった」
 *      場合は 'pending' が残るので、次回起動で再試行される。
 */
export const SETTINGS_SCHEMA_VERSION = 4

/** v1 時点のデフォルト値。移行判定にのみ使う。 */
const LEGACY_DEFAULT_SILENCE_MS = 5000
const LEGACY_DEFAULT_WHISPER_MODEL: WhisperModel = 'medium'
/**
 * v1.1.0(一般公開した最後の版)の既定 LLM。スキーマ v4 の移行判定にのみ使う。
 * 「自分で 3B を選んだ人」と「既定のまま触っていない人」は保存値からは区別できない。
 * どちらも移行対象にする(メンテナ判断。設定画面から戻せることを通知で案内する)。
 */
export const LEGACY_DEFAULT_LLM_MODEL = 'llama3.2:3b'

/**
 * 旧既定 LLM から同梱モデルへの一度きりの移行の状態。
 * - 'idle'    : 何もしない(対象外 / 完了済み / 通知を閉じた)
 * - 'pending' : ローダーが対象と判定した。backend での確認待ち(確認できるまで毎起動再試行)
 * - 'notice'  : 切り替えた。通知をまだ閉じていない
 */
export type BundledLlmMigrationState = 'idle' | 'pending' | 'notice'

function isBundledLlmMigrationState(value: unknown): value is BundledLlmMigrationState {
  return value === 'idle' || value === 'pending' || value === 'notice'
}

// nodejs-whisper の MODELS_LIST に含まれ、かつ Hugging Face で実在する
// `ggml-${name}.bin` を持つ名前のみ許可する。
// - `large-v3` は nodejs-whisper の MODELS_LIST に無いため拒否される
// - `large`(無印)は HF 上に ggml-large.bin が無く 404 になるため除外
export type WhisperModel =
  | 'tiny'
  | 'tiny.en'
  | 'base'
  | 'base.en'
  | 'small'
  | 'small.en'
  | 'medium'
  | 'medium.en'
  | 'large-v1'
  | 'large-v3-turbo'

export const VALID_WHISPER_MODELS = new Set<WhisperModel>([
  'tiny',
  'tiny.en',
  'base',
  'base.en',
  'small',
  'small.en',
  'medium',
  'medium.en',
  'large-v1',
  'large-v3-turbo',
])

/**
 * 会話に使える LLM の判定は **backend/src/shared/llm-models.ts が唯一の出典**。
 *
 * v1.1.0 までは同じ一覧をここに手書きでミラーしていて、CLAUDE.md にも
 * 「手動同期が必要」と書いてあった。片側だけ足すと「設定画面には出るのに
 * backend が既定へ落とす」(またはその逆)という、ユーザーからは原因の
 * 見えない不整合になる。二重化そのものを消したので、ここは再 export だけ。
 */
export {
  BUNDLED_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  findCatalogEntry,
  isAllowedLlmModel,
  LLM_CATALOG,
  llmParameterBillions,
  resolveProfileLevel,
  type LlmCatalogEntry,
  type ModelProfileLevel,
  type ModelProfilePref,
} from '../../../backend/src/shared/llm-models'

export type DarkModePref = 'system' | 'light' | 'dark'

/**
 * TTS rate / pitch の許容範囲(UI のスライダー範囲と一致させる)。
 * 範囲外の値が localStorage に保存されていた場合は clamp する。
 */
export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 1.5
export const TTS_PITCH_MIN = 0.7
export const TTS_PITCH_MAX = 1.4

export interface AppSettings {
  aiCharacter: {
    name: string
    gender: Gender
    /**
     * Web Speech API の voice.name(例: "Samantha", "Daniel")。
     * null の場合は gender ベースのフォールバック(下位互換)を使う。
     */
    voiceName: string | null
    /** AI の性格プリセット。デフォルト 'friendly' は従来挙動を踏襲。 */
    personality: PersonalityPreset
  }
  silenceDurationMs: number
  llmModel: string
  /**
   * 会話プロファイルの指定。
   * - 'auto'     : モデル名のパラメータ数から backend が推定(2B 以下 = small)
   * - 'standard' : 常に従来設定(長いプロンプト / 履歴 10 往復 / 単語カードあり)
   * - 'small'    : 常に軽量設定(短いプロンプト / 履歴 4 往復 / 単語カードなし)
   * 添削(grammar-check)はどちらでも出る。
   */
  modelProfile: ModelProfilePref
  whisperModel: WhisperModel
  darkMode: DarkModePref
  ttsRateConnectedToLevel: boolean
  /**
   * ttsRateConnectedToLevel=false のときに使うユーザー指定の話速。
   * 連動時は無視され、speakRateForLevel() の結果が使われる。
   */
  ttsRate: number
  /** TTS の声の高さ。常にユーザー指定値を使う(連動オプション無し)。 */
  ttsPitch: number
  /** AI 返答に日本語訳を表示するか。true(表示)がデフォルト。 */
  showJapanese: boolean
  /**
   * 返答のストリーミング読み上げを使うか(既定 true)。
   *
   * **キルスイッチ**。バックエンドを差し替えずに、クライアント側だけで
   * 旧来の一括生成へ戻せるようにするためのもの。
   * true でも、バックエンドが `/api/health` の features で機能を申告していなければ
   * ストリーミングは使われない(機能検出は常に肯定的に行う)。
   */
  streaming: boolean
  lastCleanupAt: number | null
  defaultLevel: Level
  /**
   * 旧既定 LLM(`llama3.2:3b`)→ 同梱モデルの一度きりの移行の状態(スキーマ v4)。
   * 詳細は {@link BundledLlmMigrationState} と utils/bundled-llm-migration.ts。
   */
  bundledLlmMigration: BundledLlmMigrationState
  /** 保存済み設定のスキーマ版。欠落 = 1(v1.0.0 以前)として扱う。 */
  schemaVersion: number
}

/** 無音自動送信の間隔(ミリ秒)の許容範囲。UI のスライダー範囲と一致させる。 */
export const SILENCE_MS_MIN = 1000
export const SILENCE_MS_MAX = 15000

export const DEFAULT_SETTINGS: AppSettings = {
  aiCharacter: {
    name: 'Emma',
    gender: 'female',
    voiceName: null,
    personality: 'friendly',
  },
  // 1.5秒: 話し終わってから送信されるまでの猶予。設定画面で 1-15 秒に調整可能。
  // 5秒だと毎ターン無言の待ち時間が乗って体感が大幅に悪化するため短縮した。
  silenceDurationMs: 1500,
  // ⚠️ **必ず同梱モデル**(backend/src/shared/llm-models.ts の BUNDLED_LLM_MODEL)。
  // 既定が同梱物でないと、ネットの無い初回起動が「選ばれているモデルを取得できない」
  // 行き止まりになる。v1.2.0 で 3B → llama3.2:1b、次のリリースで日本語訳の品質のため
  // qwen2.5:1.5b に変更した(理由と評価の数字は llm-models.ts の BUNDLED_LLM_MODEL)。
  // 1.5B は自動判定で軽量モード(短い返答 / 日本語訳と添削あり / 単語カードなし)になる。
  // これは意図した結果で、どの画面も追加ダウンロードは薦めない(3B の日本語訳は良くならなかった)。
  llmModel: DEFAULT_LLM_MODEL,
  // 新規ユーザーは自動判定。1B / 1.5B を選べば自動で軽量モードになる。
  modelProfile: 'auto',
  // small(多言語・約488MB): 8GB Mac でも現実的な速度/RAM。日本語入力を扱うので `.en` は不可。
  whisperModel: 'small',
  darkMode: 'system',
  ttsRateConnectedToLevel: true,
  ttsRate: 1.0,
  ttsPitch: 1.0,
  showJapanese: true,
  streaming: true,
  lastCleanupAt: null,
  defaultLevel: 'intermediate',
  // 新規ユーザーは移行の対象外(既定が最初から同梱モデル)。
  bundledLlmMigration: 'idle',
  schemaVersion: SETTINGS_SCHEMA_VERSION,
}

const VALID_PERSONALITIES = new Set<PersonalityPreset>([
  'friendly',
  'teacher',
  'cool',
  'kohai',
  'colleague',
])

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function isStorageAvailable(): boolean {
  return typeof globalThis.localStorage !== 'undefined'
}

export function loadSettings(): AppSettings {
  if (!isStorageAvailable()) return { ...DEFAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      aiCharacter: {
        ...DEFAULT_SETTINGS.aiCharacter,
        ...(parsed.aiCharacter ?? {}),
      },
    }
    // 過去バージョンで保存されたサポート外の whisperModel(例: `large-v3`)を
    // 検出してデフォルトに戻す。そうしないと nodejs-whisper が拒否する。
    if (!VALID_WHISPER_MODELS.has(merged.whisperModel)) {
      console.warn(
        `[settings] Unsupported whisperModel "${merged.whisperModel}" detected; falling back to "${DEFAULT_SETTINGS.whisperModel}"`,
      )
      merged.whisperModel = DEFAULT_SETTINGS.whisperModel
    }
    // 旧バージョンに無かったフィールドのマイグレーション。
    // voiceName / personality は aiCharacter の中で欠落しているケースを補完する。
    if (typeof merged.aiCharacter.voiceName === 'undefined') {
      merged.aiCharacter.voiceName = null
    }
    if (!VALID_PERSONALITIES.has(merged.aiCharacter.personality)) {
      merged.aiCharacter.personality = DEFAULT_SETTINGS.aiCharacter.personality
    }
    // ttsRate / ttsPitch は範囲外のときデフォルトに戻す(clamp で防御)
    merged.ttsRate = clamp(
      typeof merged.ttsRate === 'number' ? merged.ttsRate : DEFAULT_SETTINGS.ttsRate,
      TTS_RATE_MIN,
      TTS_RATE_MAX,
    )
    merged.ttsPitch = clamp(
      typeof merged.ttsPitch === 'number' ? merged.ttsPitch : DEFAULT_SETTINGS.ttsPitch,
      TTS_PITCH_MIN,
      TTS_PITCH_MAX,
    )
    // --- スキーマ移行(1 → 2): silenceDurationMs の旧デフォルト 5000 を新デフォルトへ ---
    // 旧デフォルトのまま使っていた人だけが対象。自分で値を変えていた人の設定は尊重する。
    const storedVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1
    const needsMigration = storedVersion < SETTINGS_SCHEMA_VERSION
    if (storedVersion < 2) {
      if (merged.silenceDurationMs === LEGACY_DEFAULT_SILENCE_MS) {
        merged.silenceDurationMs = DEFAULT_SETTINGS.silenceDurationMs
      }
      // 旧デフォルトの medium は DMG に同梱されなくなった(backend も small に
      // フォールバックする)。設定表示と実際に動くモデルを一致させるため移行する。
      // medium を自分で DL して使っていた人はファイルが残っているので設定画面で選び直せる。
      if (merged.whisperModel === LEGACY_DEFAULT_WHISPER_MODEL) {
        merged.whisperModel = DEFAULT_SETTINGS.whisperModel
      }
    }
    // --- スキーマ移行(2 → 3): 既存ユーザーの会話プロファイルを据え置く ---
    // v2 までは全モデルが standard 相当(長いプロンプト / 履歴 10 往復 / 当時は添削あり)
    // で動いていた。新設の 'auto' は 2B 以下を small へ落とすので、
    // **既に 2B を選んでいた人だけ黙って挙動が変わる**。その人には明示的に
    // 'standard' を書き込んで現状維持し、それ以外(新規含む)は 'auto' にする。
    //
    // ⚠️ この移行は **冪等でない**。移行後にユーザーが自分で 'auto' へ戻しても、
    // 再実行されればまた 'standard' に引き戻される。下の「移行したら即保存」
    // (needsMigration → saveSettings)が効いていないとこれが毎起動起きる。
    if (storedVersion < 3) {
      // ⚠️ **`merged` ではなく `parsed` の値で判定する**。merged はキーが欠けていると
      // 新しいデフォルト(= 同梱モデル。v1.2.0 で 1B になった)で埋まるため、
      // 「llmModel を保存していない旧ユーザー」が新デフォルトの 1B を根拠に
      // standard へ据え置かれてしまう。据え置くべきなのは
      // **自分で 2B 以下を選んで保存していた人**だけ。
      const storedModel = typeof parsed.llmModel === 'string' ? parsed.llmModel : null
      merged.modelProfile =
        storedModel !== null && inferProfileLevel(storedModel) === 'small' ? 'standard' : 'auto'
    }
    // 壊れた値(手編集・将来版からのダウングレード)は既定へ戻す。
    if (!isModelProfilePref(merged.modelProfile)) {
      merged.modelProfile = DEFAULT_SETTINGS.modelProfile
    }
    // --- スキーマ移行(3 → 4): 旧既定 LLM のままの人を「移行待ち」にする ---
    // ⚠️ ここでは **llmModel を書き換えない**。同梱モデルがインストール済みかは
    // backend に聞かないと分からず、入っていない Ollama(ユーザー自前の Ollama を
    // 再利用している場合)へ切り替えると毎ターン MODEL_NOT_FOUND になる。
    // 印だけ付けて、確認と切り替えは utils/bundled-llm-migration.ts に任せる。
    // v3 の移行と同じく **parsed で判定する**(merged は欠落キーを新既定で埋めるため)。
    // v4 以降に保存された 3B(= この版で自分で選んだ)は対象にしない。
    if (storedVersion < 4) {
      merged.bundledLlmMigration = parsed.llmModel === LEGACY_DEFAULT_LLM_MODEL ? 'pending' : 'idle'
    }
    if (!isBundledLlmMigrationState(merged.bundledLlmMigration)) {
      merged.bundledLlmMigration = DEFAULT_SETTINGS.bundledLlmMigration
    }
    merged.schemaVersion = SETTINGS_SCHEMA_VERSION

    // showJapanese は旧バージョンに無いので欠落時はデフォルト(表示)に
    if (typeof merged.showJapanese !== 'boolean') {
      merged.showJapanese = DEFAULT_SETTINGS.showJapanese
    }
    // streaming も旧バージョンに無い。欠落時はデフォルト(有効)に。
    // 値の形は変わらないのでスキーマ版は上げない(v2 のまま)。
    if (typeof merged.streaming !== 'boolean') {
      merged.streaming = DEFAULT_SETTINGS.streaming
    }
    // silenceDurationMs を許容範囲に clamp
    merged.silenceDurationMs = clamp(
      typeof merged.silenceDurationMs === 'number'
        ? merged.silenceDurationMs
        : DEFAULT_SETTINGS.silenceDurationMs,
      SILENCE_MS_MIN,
      SILENCE_MS_MAX,
    )
    // 移行が走ったらその場で永続化する。ストアは「変更されたとき」しか保存しないので、
    // ここで書かないと設定を一度も触らないユーザーは schemaVersion が保存されないまま
    // 毎回起動のたびに移行が再実行される(= 一度きりの移行という契約が嘘になる)。
    // 今の v1→v2 は冪等なので実害は無いが、冪等でない v2→v3 を足した瞬間に壊れる。
    if (needsMigration) {
      saveSettings(merged)
    }
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: AppSettings): void {
  if (!isStorageAvailable()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage may be full or unavailable
  }
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    aiCharacter: {
      ...current.aiCharacter,
      ...(patch.aiCharacter ?? {}),
    },
  }
  saveSettings(next)
  return next
}

export function resetSettings(): AppSettings {
  if (isStorageAvailable()) {
    localStorage.removeItem(STORAGE_KEY)
  }
  return { ...DEFAULT_SETTINGS }
}

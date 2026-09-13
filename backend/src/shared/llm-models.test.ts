import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_LLM_FAMILIES,
  BUNDLED_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  LLM_CATALOG,
  inferProfileLevel,
  isAllowedLlmModel,
  isModelProfilePref,
  isValidModelName,
  llmFamilyOf,
  llmParameterBillions,
  resolveProfileLevel,
} from './llm-models.js'
import { resolveLlmModel } from '../services/ollama.js'

/**
 * ここで固定しているのは「どのモデル名を通し、どれを既定へ落とすか」。
 *
 * v1.1.0 までは完全一致の Set だったので、量子化タグ(`:3b-instruct-q4_K_M`)を
 * 自分で pull したユーザーは **静かに既定モデルへ落とされ**、設定画面の一覧からも
 * そのモデルが消えていた(選べない理由もどこにも出ない)。
 * ファミリー一致へ緩めたぶん、「緩めすぎていない」ことをここで縛る。
 */

describe('isValidModelName(書式の門番)', () => {
  it.each([
    'llama3.2:3b',
    'llama3.2:1b',
    'qwen2.5:1.5b',
    'gemma2:2b',
    // 量子化タグ: 大文字とアンダースコアが出る
    'llama3.2:3b-instruct-q4_K_M',
    'qwen2.5:7b-instruct-q5_0',
    'gemma2:9b-instruct-fp16',
    'llama3.1:8b-instruct-Q8_0',
    // タグ無し(Ollama が :latest を補う)
    'llama3.2',
  ])('通す: %s', (name) => {
    expect(isValidModelName(name)).toBe(true)
  })

  it.each([
    ['空文字', ''],
    ['空白だけ', '   '],
    ['前後に空白', ' llama3.2:3b '],
    ['スペース入り', 'llama 3.2:3b'],
    ['改行入り', 'llama3.2:3b\n'],
    ['タグが空', 'llama3.2:'],
    ['コロンだけ', ':'],
    ['大文字始まり', 'Llama3.2:3b'],
    ['記号始まり', '-llama3.2:3b'],
    ['パスっぽい', '../../etc/passwd'],
    ['親ディレクトリ参照', 'llama3.2:3b/../x'],
    ['URL', 'http://evil.example/model'],
    ['シェルメタ文字', 'llama3.2:3b;rm -rf /'],
    ['クエリ', 'llama3.2:3b?x=1'],
    // 名前空間付きは **書式の段階で** 弾く。通すとファミリーが
    // `library/llama3.2` になって allowlist に当たらず、「名前は正しいのに
    // 黙って既定へ落ちる」= このステージで潰したはずの穴が残る。
    ['名前空間付き(library)', 'library/llama3.2:3b'],
    ['名前空間付き(他ユーザー)', 'someone/llama3.2:3b'],
    ['レジストリ付き', 'hf.co/user/model:Q4_K_M'],
    ['NUL 文字', 'llama3.2:3b\u0000'],
    ['長すぎる', `${'a'.repeat(200)}:3b`],
  ])('落とす: %s', (_label, name) => {
    expect(isValidModelName(name)).toBe(false)
  })

  it('文字列以外は落とす', () => {
    expect(isValidModelName(undefined)).toBe(false)
    expect(isValidModelName(null)).toBe(false)
    expect(isValidModelName(42)).toBe(false)
    expect(isValidModelName({ toString: () => 'llama3.2:3b' })).toBe(false)
  })
})

describe('llmFamilyOf', () => {
  it('コロンの前をファミリーとして返す', () => {
    expect(llmFamilyOf('llama3.2:3b-instruct-q4_K_M')).toBe('llama3.2')
    expect(llmFamilyOf('qwen2.5:1.5b')).toBe('qwen2.5')
  })

  it('タグが無ければ全体がファミリー', () => {
    expect(llmFamilyOf('gemma2')).toBe('gemma2')
  })

  it('書式が不正なら null', () => {
    expect(llmFamilyOf('llama 3.2:3b')).toBeNull()
  })
})

describe('isAllowedLlmModel(ファミリー一致)', () => {
  it.each([
    'llama3.2:3b',
    'llama3.2:1b',
    'llama3.1:8b',
    'gemma2:2b',
    'gemma2:9b',
    'qwen2.5:1.5b',
    'qwen2.5:7b',
    'qwen2.5:14b',
  ])('許可ファミリーの型番は通る: %s', (name) => {
    expect(isAllowedLlmModel(name)).toBe(true)
  })

  it.each([
    'llama3.2:3b-instruct-q4_K_M',
    'llama3.2:1b-instruct-q8_0',
    'qwen2.5:1.5b-instruct-q4_K_M',
    'gemma2:9b-instruct-fp16',
  ])('量子化タグも同じファミリーとして通る: %s', (name) => {
    expect(isAllowedLlmModel(name)).toBe(true)
  })

  it.each([
    ['別ファミリー(mistral)', 'mistral:7b'],
    ['別ファミリー(phi3)', 'phi3:mini'],
    ['別ファミリー(llama3 — 3.1/3.2 とは別物)', 'llama3:8b'],
    ['前方一致のなりすまし', 'llama3.2-evil:3b'],
    ['名前空間付きは書式の段階で落ちる', 'someone/llama3.2:3b'],
    ['埋め込みモデル', 'nomic-embed-text'],
    ['書式が不正', 'llama3.2:3b;rm -rf /'],
    ['空文字', ''],
  ])('落とす: %s', (_label, name) => {
    expect(isAllowedLlmModel(name)).toBe(false)
  })
})

describe('resolveLlmModel(backend の入口)', () => {
  it('許可された型番はそのまま使う', () => {
    expect(resolveLlmModel('qwen2.5:1.5b')).toBe('qwen2.5:1.5b')
  })

  it('量子化タグも既定へ落とさない(v1.1.0 までの退行)', () => {
    expect(resolveLlmModel('llama3.2:3b-instruct-q4_K_M')).toBe('llama3.2:3b-instruct-q4_K_M')
  })

  it('未許可 / 壊れた名前は既定へ落とす', () => {
    expect(resolveLlmModel('mistral:7b')).toBe(DEFAULT_LLM_MODEL)
    expect(resolveLlmModel('llama3.2:3b; echo hi')).toBe(DEFAULT_LLM_MODEL)
    expect(resolveLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL)
  })
})

describe('llmParameterBillions(タグからパラメータ数)', () => {
  it.each([
    ['llama3.2:1b', 1],
    ['llama3.2:3b', 3],
    ['qwen2.5:1.5b', 1.5],
    ['gemma2:2b', 2],
    ['llama3.1:8b', 8],
    ['gemma2:9b', 9],
    ['qwen2.5:14b', 14],
    // 量子化 / instruct タグが後ろに付いても読める
    ['llama3.2:1b-instruct-q4_K_M', 1],
    ['qwen2.5:1.5b-instruct-q5_0', 1.5],
    ['gemma2:9b-instruct-fp16', 9],
    ['llama3.1:8b-instruct-Q8_0', 8],
    ['qwen2.5:7b-text-v0.2-q4_0', 7],
  ])('%s → %s B', (name, expected) => {
    expect(llmParameterBillions(name)).toBe(expected)
  })

  it('ファミリー側のバージョン番号をパラメータ数と読み違えない', () => {
    // `llama3.2` の "3.2" を拾うと 1B を選んでも small に落ちなくなる
    expect(llmParameterBillions('llama3.2:1b')).toBe(1)
    expect(llmParameterBillions('qwen2.5:1.5b')).toBe(1.5)
  })

  it.each([
    ['タグが無い', 'llama3.2'],
    ['latest タグ', 'llama3.2:latest'],
    ['量子化だけのタグ', 'llama3.2:q4_K_M'],
    ['書式が不正', 'llama 3.2:3b'],
  ])('読めなければ null: %s', (_label, name) => {
    expect(llmParameterBillions(name)).toBeNull()
  })
})

describe('inferProfileLevel(自動判定)', () => {
  it.each(['llama3.2:1b', 'qwen2.5:1.5b', 'gemma2:2b', 'llama3.2:1b-instruct-q4_K_M'])(
    '2B 以下は small: %s',
    (name) => {
      expect(inferProfileLevel(name)).toBe('small')
    },
  )

  it.each([
    'llama3.2:3b',
    'llama3.1:8b',
    'gemma2:9b',
    'qwen2.5:14b',
    'llama3.2:3b-instruct-q4_K_M',
  ])('3B 以上は standard: %s', (name) => {
    expect(inferProfileLevel(name)).toBe('standard')
  })

  it('パラメータ数が読めないものは standard に倒す(切り詰めすぎない)', () => {
    expect(inferProfileLevel('llama3.2:latest')).toBe('standard')
    expect(inferProfileLevel('llama3.2')).toBe('standard')
    expect(inferProfileLevel(undefined)).toBe('standard')
  })
})

describe('resolveProfileLevel(設定値との組み合わせ)', () => {
  it('auto はモデル名から推定する', () => {
    expect(resolveProfileLevel('auto', 'llama3.2:1b')).toBe('small')
    expect(resolveProfileLevel('auto', 'qwen2.5:1.5b')).toBe('small')
    expect(resolveProfileLevel('auto', 'gemma2:9b')).toBe('standard')
  })

  it('未指定は auto と同じ', () => {
    expect(resolveProfileLevel(undefined, 'llama3.2:1b')).toBe('small')
  })

  it('明示指定はモデル名より強い(どちらの向きでも)', () => {
    expect(resolveProfileLevel('standard', 'llama3.2:1b')).toBe('standard')
    expect(resolveProfileLevel('small', 'qwen2.5:14b')).toBe('small')
  })
})

describe('isModelProfilePref', () => {
  it('3 値だけを受け付ける', () => {
    expect(isModelProfilePref('auto')).toBe(true)
    expect(isModelProfilePref('standard')).toBe(true)
    expect(isModelProfilePref('small')).toBe(true)
    expect(isModelProfilePref('tiny')).toBe(false)
    expect(isModelProfilePref(undefined)).toBe(false)
    expect(isModelProfilePref(1)).toBe(false)
  })
})

describe('カタログの一貫性', () => {
  it('カタログの型番はすべて allowlist を通る', () => {
    for (const entry of LLM_CATALOG) {
      expect(isAllowedLlmModel(entry.tag), entry.tag).toBe(true)
    }
  })

  it('既定モデルはカタログに載っていて allowlist を通る', () => {
    expect(LLM_CATALOG.some((e) => e.tag === DEFAULT_LLM_MODEL)).toBe(true)
    expect(isAllowedLlmModel(DEFAULT_LLM_MODEL)).toBe(true)
  })

  it('型番の重複が無い', () => {
    const tags = LLM_CATALOG.map((e) => e.tag)
    expect(new Set(tags).size).toBe(tags.length)
  })

  it('8GB 機向けに薦めるのは 1B / 1.5B / 2B / 3B だけ', () => {
    for (const entry of LLM_CATALOG) {
      const billions = llmParameterBillions(entry.tag)
      expect(billions, entry.tag).not.toBeNull()
      expect(entry.lightweight, entry.tag).toBe(billions! <= 3)
    }
  })

  it('ファミリー一覧に重複が無い', () => {
    expect(new Set(ALLOWED_LLM_FAMILIES).size).toBe(ALLOWED_LLM_FAMILIES.length)
  })
})

/**
 * 同梱物の整合。**このアプリの一番の売り(完全オフライン動作)を守る**テスト。
 *
 * v1.1.0 直前の状態: オンボーディングは 12GB 未満の Mac に `llama3.2:1b` を
 * あらかじめ選んでいたのに、DMG に同梱していたのは `llama3.2:3b` だけだった。
 * ネットの無い 8GB 機では「選ばれているモデルが取得できず次へ進めない」
 * = 初回起動が行き止まり。コードのどこを読んでも矛盾が見えないのが厄介で、
 * 「既定モデル」「同梱モデル」「prep スクリプトが pull するモデル」の 3 つが
 * 別々の場所に書かれていたことが原因だった。ここで縛る。
 */
describe('同梱モデルの整合', () => {
  it('既定モデルは同梱モデルと一致する(オフライン初回起動の前提)', () => {
    expect(DEFAULT_LLM_MODEL).toBe(BUNDLED_LLM_MODEL)
  })

  it('カタログで bundled=true なのは同梱モデルだけ', () => {
    const bundled = LLM_CATALOG.filter((e) => e.bundled).map((e) => e.tag)
    expect(bundled).toEqual([BUNDLED_LLM_MODEL])
  })

  it('同梱モデルはカタログに載っている', () => {
    expect(LLM_CATALOG.some((e) => e.tag === BUNDLED_LLM_MODEL)).toBe(true)
  })

  it('カタログの説明は、計測していない精度や「取得すると添削が戻る」を謳わない', () => {
    // 添削はプロファイルに依らず grammar-check が出す。3B の日本語訳は同梱モデルより良くならなかった。
    // 9B / 14B の精度は計測していない。
    for (const e of LLM_CATALOG) {
      expect(e.note, e.tag).not.toMatch(/おすすめ|高品質|精度重視/)
      expect(e.note, e.tag).not.toMatch(/添削[^・]*(戻|出るように)/)
    }
  })

  it('同梱モデルは自動判定で軽量モードになる(= 単語カードが出ないことを UI が言い切れる)', () => {
    // 小数のタグ(`1.5b`)が 1.5 と読めていることまで見る。
    // `1.5b` の "5b" だけを拾うと 5B = standard になり、同梱直後から
    // 8GB 機で長いプロンプトが走る(このテストが守りたい状況そのもの)。
    expect(llmParameterBillions(BUNDLED_LLM_MODEL)).toBe(1.5)
    expect(inferProfileLevel(BUNDLED_LLM_MODEL)).toBe('small')
    expect(resolveProfileLevel('auto', BUNDLED_LLM_MODEL)).toBe('small')
    expect(resolveProfileLevel(undefined, BUNDLED_LLM_MODEL)).toBe('small')
  })

  it('同梱モデルは取得の選択肢にも出る(消してしまった人が取り直せる)', () => {
    expect(LLM_CATALOG.find((e) => e.tag === BUNDLED_LLM_MODEL)?.offerForDownload).toBe(true)
  })

  /**
   * v1.2.0 の同梱物 `llama3.2:1b` は、実モデル評価で日本語訳の欄が 60 回中 28 回
   * 日本語にならず、英→日の意味が正しかったのは 12 回中 0 回だった
   * (Llama 3.2 は日本語を公式に非対応)。
   * - **こちらから薦めない**: 取得フォーム / オンボーディングの選択肢に出さない
   * - **既に入っている人は壊さない**: allowlist は通り、既定へ黙って落とされない
   */
  it('llama3.2:1b は薦めないが、入っている人はそのまま使える', () => {
    const entry = LLM_CATALOG.find((e) => e.tag === 'llama3.2:1b')
    expect(entry, 'インストール済み一覧に説明を出すためカタログには残す').toBeDefined()
    expect(entry!.offerForDownload).toBe(false)
    expect(entry!.bundled).toBe(false)
    expect(isAllowedLlmModel('llama3.2:1b')).toBe(true)
    expect(resolveLlmModel('llama3.2:1b')).toBe('llama3.2:1b')
  })

  it('llama3.2:3b は自動判定で標準モードになる(単語カードあり)', () => {
    expect(inferProfileLevel('llama3.2:3b')).toBe('standard')
  })

  it('prep スクリプトが vendor するモデルが BUNDLED_LLM_MODEL と一致する', () => {
    // ⚠️ prep スクリプトは .mjs なのでこの定数を import できない(node が .ts を読めない)。
    // 二重化は避けられないので、**ズレたらここで落ちる**ようにしてある。
    // これが無いと「コード上は Qwen なのに DMG には Llama が入っている」状態が
    // 実機で起動するまで誰にも見えない(ファイル名は歴史的経緯で prep-llama-model のまま)。
    const here = dirname(fileURLToPath(import.meta.url))
    const prepPath = resolve(here, '..', '..', '..', 'scripts', 'prep-llama-model.mjs')
    const source = readFileSync(prepPath, 'utf-8')

    // `ollama pull` に渡す名前。
    const model = /^const MODEL = '([^']+)'$/m.exec(source)?.[1]
    expect(model, 'prep-llama-model.mjs の MODEL を読めなかった').toBe(BUNDLED_LLM_MODEL)

    // コピー元 / コピー先の manifest パスと、掃除(pruneStaleVendored)で残す
    // <family>/<tag> はこの 2 つから作られる。MODEL だけ直して family/tag を
    // 直し忘れると、pull は新モデル・vendor と掃除は旧モデルになり、
    // **新モデルの manifest を掃除が消す**。
    const family = /^const MODEL_FAMILY = '([^']+)'$/m.exec(source)?.[1]
    const tag = /^const MODEL_TAG = '([^']+)'$/m.exec(source)?.[1]
    expect(family, 'MODEL_FAMILY を読めなかった').toBeDefined()
    expect(tag, 'MODEL_TAG を読めなかった').toBeDefined()
    expect(`${family}:${tag}`).toBe(BUNDLED_LLM_MODEL)
    expect(family).toBe(llmFamilyOf(BUNDLED_LLM_MODEL))

    // manifest のパスが手書きではなく family/tag から組み立てられていること
    // (手書きだと上の一致が取れていても別モデルの manifest を読みに行ける)。
    expect(source).toMatch(
      /^const MANIFEST_REL = `manifests\/registry\.ollama\.ai\/library\/\$\{MODEL_FAMILY\}\/\$\{MODEL_TAG\}`$/m,
    )
  })
})

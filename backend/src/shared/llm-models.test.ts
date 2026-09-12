import { describe, expect, it } from 'vitest'
import {
  ALLOWED_LLM_FAMILIES,
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

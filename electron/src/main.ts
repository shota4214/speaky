import { app, BrowserWindow, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { ElectronOllama } from 'electron-ollama'

const BACKEND_PORT = 3001
const BACKEND_HOST = '127.0.0.1'
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`

// Ollama sidecar の起動タイムアウト(秒)。
// 初回起動は Ollama ランタイム (~150MB) を DL してから起動するため、
// デフォルトの 5 秒では確実にタイムアウトする。
// 初回 DL 込み + 起動余裕として 120 秒を確保する。
const OLLAMA_SERVE_TIMEOUT_SEC = 120

// 同梱する Ollama ランタイムのバージョン(GitHub tag そのまま "vX.Y.Z" 形式)。
// scripts/prep-ollama-binary.mjs の OLLAMA_VERSION と必ず一致させること。
// electron-ollama は getBinPath(version) = basePath/electron-ollama/<version>/<os>/<arch>
// でバイナリを解決し、isDownloaded(version)=true なら GitHub API も DL も呼ばずに serve する。
// 'latest' をやめて特定 tag を pin することで、初回起動でネットを一切叩かないようにする。
const OLLAMA_VERSION = 'v0.30.4'

// electron-ollama が basePath 配下に作るルートディレクトリ名(ライブラリのデフォルト)。
// 同梱バイナリの userData への同期先・vendor 元のレイアウトでこの名前を使う。
const ELECTRON_OLLAMA_DIR = 'electron-ollama'

// アプリ終了時の Ollama サーバ stop() に許す最大待ち時間(ミリ秒)。
// stop() がハングしてもアプリが終了不能にならないよう打ち切る。
const OLLAMA_STOP_TIMEOUT_MS = 5_000

const isPackaged = app.isPackaged
// 開発時に「ビルド済み frontend + spawn backend」を試すモード
const loadBuild = isPackaged || process.env.SPEAKY_LOAD_BUILD === '1'

let backendProc: ChildProcess | null = null
let ollamaManager: ElectronOllama | null = null

interface RuntimeLayout {
  entryPath: string
  /** spawn の cwd。backend が process.cwd()/node_modules/nodejs-whisper を解決できる位置 */
  runtimeDir: string
  frontendDist: string
  /** SPEAKY_WHISPER_BASE_DIR に渡す絶対パス。writable であること */
  whisperPackageDir: string
  /** 同梱した ffmpeg-static のディレクトリ(null なら system PATH の ffmpeg に頼る) */
  ffmpegDir: string | null
  /** OLLAMA_MODELS にセットする writable なディレクトリ(packaged のみ。dev では null) */
  ollamaModelsDir: string | null
}

function findFfmpegDir(searchRoots: string[]): string | null {
  for (const root of searchRoots) {
    const candidate = path.join(root, 'node_modules', 'ffmpeg-static')
    if (existsSync(path.join(candidate, 'ffmpeg'))) {
      return candidate
    }
  }
  return null
}

/**
 * setupRuntime() の事前計算結果。
 * packaged 版で「同期(cpSync)が必要かどうか」を起動フローの上流で判定するために分離した。
 * needsSync=true なら起動前にスプラッシュを出してから {@link runRuntimeSync} を呼ぶ。
 */
interface RuntimePlan {
  layout: RuntimeLayout
  needsSync: boolean
  /** packaged 時のみ非 null。dev では null(同期不要なので使わない) */
  sync: {
    templateDir: string
    runtimeDir: string
    ollamaTemplateDir: string
    ollamaModelsDir: string
    /** 同梱した Ollama ランタイムバイナリ一式(electron-ollama レイアウト)の vendor 元 */
    ollamaBinTemplateDir: string
    /** バイナリをコピーする userData 側のルート(electron-ollama の basePath 直下) */
    ollamaBinTargetDir: string
    versionFile: string
    currentVersion: string
  } | null
}

/**
 * packaged: process.resourcesPath/backend-template/* を userData/backend-runtime/ にコピー(初回のみ)
 *   .app/Contents/Resources は read-only なので、Whisper モデル DL や whisper.cpp ビルドの
 *   書き込み先として直接使えない。書き込み可能な userData にコピーして cwd を固定する。
 *
 *   実コピーは {@link runRuntimeSync} で行い、この関数はパス計算と needsSync 判定だけを返す。
 *   呼び出し側は needsSync=true のときにスプラッシュを表示してから sync を実行する。
 *
 * dev:packaged: workspace のパスをそのまま使う(root の node_modules は writable)
 */
function planRuntime(): RuntimePlan {
  if (!isPackaged) {
    const workspaceRoot = path.resolve(__dirname, '..', '..')
    return {
      layout: {
        entryPath: path.join(workspaceRoot, 'backend', 'dist', 'index.js'),
        runtimeDir: path.join(workspaceRoot, 'backend', 'dist'),
        frontendDist: path.join(workspaceRoot, 'frontend', 'dist'),
        whisperPackageDir: path.join(workspaceRoot, 'node_modules', 'nodejs-whisper'),
        ffmpegDir: findFfmpegDir([path.join(workspaceRoot, 'backend', 'vendor'), workspaceRoot]),
        ollamaModelsDir: null,
      },
      needsSync: false,
      sync: null,
    }
  }

  const userData = app.getPath('userData')
  const runtimeDir = path.join(userData, 'backend-runtime')
  const entryPath = path.join(runtimeDir, 'index.cjs')
  const whisperPackageDir = path.join(runtimeDir, 'node_modules', 'nodejs-whisper')
  const templateDir = path.join(process.resourcesPath, 'backend-template')
  // Ollama モデルの保存先。Ollama は OLLAMA_MODELS に
  // {blobs,manifests}/ を期待するので、その親を userData 配下の固定パスに置く。
  const ollamaModelsDir = path.join(userData, 'ollama-data', 'models')
  const ollamaTemplateDir = path.join(templateDir, 'ollama-data')

  // 同梱した Ollama ランタイムバイナリ。
  //   vendor 元: <resources>/backend-template/ollama-bin/electron-ollama/<ver>/darwin/arm64/...
  //   コピー先: <userData>/electron-ollama/<ver>/darwin/arm64/...
  // electron-ollama({ basePath: userData }) の getBinPath(<ver>) がこのパスを指す。
  const ollamaBinTemplateDir = path.join(templateDir, 'ollama-bin', ELECTRON_OLLAMA_DIR)
  const ollamaBinTargetDir = path.join(userData, ELECTRON_OLLAMA_DIR)

  if (!existsSync(templateDir)) {
    throw new Error(`backend-template not found at ${templateDir}. Bundle is broken.`)
  }

  // 「現在のアプリ版で同期した runtime か?」を version.json で記録。
  // アプリ更新で版が変わったら、ユーザーDLしたモデルを保護したうえで
  // backend コード+vendor を template から再同期する。
  // 同じ version 判定で Ollama モデル(同梱バンドル)も再同期する。
  const versionFile = path.join(runtimeDir, 'version.json')
  const currentVersion = app.getVersion()

  let storedVersion: string | null = null
  if (existsSync(versionFile)) {
    try {
      const parsed = JSON.parse(readFileSync(versionFile, 'utf-8')) as { version?: string }
      storedVersion = parsed.version ?? null
    } catch {
      storedVersion = null
    }
  }

  const needsSync = !existsSync(entryPath) || storedVersion !== currentVersion

  return {
    layout: {
      entryPath,
      runtimeDir,
      frontendDist: path.join(process.resourcesPath, 'frontend-dist'),
      whisperPackageDir,
      ffmpegDir: findFfmpegDir([runtimeDir]),
      ollamaModelsDir,
    },
    needsSync,
    sync: {
      templateDir,
      runtimeDir,
      ollamaTemplateDir,
      ollamaModelsDir,
      ollamaBinTemplateDir,
      ollamaBinTargetDir,
      versionFile,
      currentVersion,
    },
  }
}

/**
 * 同期コピーを実行する。3GB 超を `cpSync` するので 30〜60 秒ブロックする想定。
 * 呼び出し前に必ずスプラッシュを表示し、UI スレッドを返してから実行すること
 * (`setImmediate` 経由)。
 */
function runRuntimeSync(sync: NonNullable<RuntimePlan['sync']>): void {
  console.log(
    `[electron] runtime sync starting: target=${sync.currentVersion} dir=${sync.runtimeDir}`,
  )
  syncRuntime(sync.templateDir, sync.runtimeDir)
  syncOllamaModels(sync.ollamaTemplateDir, sync.ollamaModelsDir)
  syncOllamaBinary(sync.ollamaBinTemplateDir, sync.ollamaBinTargetDir)
  writeFileSync(sync.versionFile, JSON.stringify({ version: sync.currentVersion }, null, 2))
  console.log(`[electron] runtime synced to ${sync.currentVersion}`)
}

/**
 * Ollama モデル(同梱バンドル)を userData/ollama-data/models/ に同期する。
 *
 * 設計:
 *   - blob は content-addressed(sha256)なのでファイル名が一致すれば内容も一致する前提。
 *     → 既存ファイルを潰さず、template に無いユーザー DL 分(Gemma 2 9B 等)を保護できる
 *   - ただしユーザー側 DL 中のクラッシュで残った中途半端な blob(サイズ不一致)は
 *     content-addressed の前提を満たさないので、サイズが食い違ったら template 版で上書き救済する。
 *   - manifest は template 側で更新される可能性があるので、上書きで template 側を反映する
 *     ユーザーが pull した別モデルの manifest は別ディレクトリにあるので影響しない
 *
 * テンプレート側に ollama-data が無いケース(将来同梱を外す等)は単純に no-op。
 */
function syncOllamaModels(templateOllamaDir: string, targetModelsDir: string): void {
  if (!existsSync(templateOllamaDir)) {
    console.log('[electron] no bundled ollama-data in template; skipping ollama sync')
    return
  }

  mkdirSync(targetModelsDir, { recursive: true })

  // blob: 既存ファイル(ユーザー DL 分含む)は基本そのまま温存。
  //  - target に無ければコピー
  //  - target にあるがサイズが template と一致しない場合は壊れているとみなして上書き
  //  - サイズが一致するなら content-addressed として信頼してスキップ
  const templateBlobsDir = path.join(templateOllamaDir, 'blobs')
  if (existsSync(templateBlobsDir)) {
    const targetBlobsDir = path.join(targetModelsDir, 'blobs')
    mkdirSync(targetBlobsDir, { recursive: true })
    let copied = 0
    let rescued = 0
    let skipped = 0
    for (const entry of readdirSync(templateBlobsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const src = path.join(templateBlobsDir, entry.name)
      const dst = path.join(targetBlobsDir, entry.name)
      if (!existsSync(dst)) {
        copyFileSync(src, dst)
        copied += 1
        continue
      }
      const srcSize = statSync(src).size
      const dstSize = statSync(dst).size
      if (srcSize !== dstSize) {
        // 中途半端な blob を template 版で救済(force overwrite)
        copyFileSync(src, dst)
        rescued += 1
      } else {
        skipped += 1
      }
    }
    if (rescued > 0) {
      console.log(`[electron] rescued ${rescued} partial ollama blob(s) by overwriting`)
    }
    console.log(`[electron] ollama blobs sync: ${copied} new, ${rescued} rescued, ${skipped} kept`)
  }

  // manifests: template に含まれるバンドル分は force=true で常に上書き
  const templateManifestsDir = path.join(templateOllamaDir, 'manifests')
  if (existsSync(templateManifestsDir)) {
    const targetManifestsDir = path.join(targetModelsDir, 'manifests')
    mkdirSync(targetManifestsDir, { recursive: true })
    cpSync(templateManifestsDir, targetManifestsDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
    })
  }

  console.log(`[electron] ollama models synced to ${targetModelsDir}`)
}

/**
 * 同梱した Ollama ランタイムバイナリ一式を userData の electron-ollama 期待パスにコピーする。
 *
 * 目的:
 *   electron-ollama の serve(version) は isDownloaded(version)=true なら GitHub API も DL も
 *   呼ばず、ローカルバイナリを spawn するだけで起動する。ここで vendor 済みバイナリを
 *   userData/electron-ollama/<ver>/<os>/<arch>/ に置いておけば、初回起動でもネット不要になる。
 *
 * 設計:
 *   - template 側(<resources>/backend-template/ollama-bin/electron-ollama/<ver>/...)を
 *     userData/electron-ollama/<ver>/... へ force コピーする。
 *   - electron-ollama が DL すると executable に +x が付くが、cpSync はパーミッションを
 *     保持するので vendor 時の +x がそのまま残る(prep スクリプトの cpSync も同様)。
 *   - template 側に ollama-bin が無いケース(将来同梱を外す等)は no-op。
 *     その場合は startOllama がフォールバックでネット DL に落ちる。
 */
function syncOllamaBinary(templateBinDir: string, targetBinDir: string): void {
  if (!existsSync(templateBinDir)) {
    console.log('[electron] no bundled ollama binary in template; skipping ollama-bin sync')
    return
  }
  mkdirSync(targetBinDir, { recursive: true })
  // <ver>/<os>/<arch>/... の構造を丸ごと反映。force で版更新時も上書きする。
  // 注意: この同期は app version(version.json)で gate される。OLLAMA_VERSION だけを
  // 上げて app version を据え置くと新バイナリが再同期されず、isDownloaded=false →
  // serve() がネット DL フォールバックになる。リリースのたびに app version も上げること。
  cpSync(templateBinDir, targetBinDir, { recursive: true, force: true, errorOnExist: false })
  console.log(`[electron] ollama binary synced to ${targetBinDir}`)
}

/**
 * runtime を template と同期する。
 * - ユーザーがDLした Whisper モデル(ggml-*.bin)は退避→復元してロスを防ぐ
 * - whisper.cpp の cmake ビルド成果物はソースが変わると壊れるので破棄
 *   (UI の「whisper.cpp をビルド」で再ビルドしてもらう)
 */
function syncRuntime(templateDir: string, runtimeDir: string): void {
  // 既存モデルを退避
  const oldModelsDir = path.join(
    runtimeDir,
    'node_modules',
    'nodejs-whisper',
    'cpp',
    'whisper.cpp',
    'models',
  )
  const backupDir = path.join(
    path.dirname(runtimeDir),
    `backend-runtime-models-backup-${Date.now()}`,
  )
  let hasBackup = false
  if (existsSync(oldModelsDir)) {
    try {
      mkdirSync(backupDir, { recursive: true })
      // *.bin だけ退避(他はテンプレートに含まれる)
      cpSync(oldModelsDir, backupDir, {
        recursive: true,
        filter: (src) => src.endsWith('.bin') || src === oldModelsDir,
      })
      hasBackup = true
    } catch (e) {
      console.warn('[electron] failed to backup models, continuing without:', e)
    }
  }

  // runtime をまるごと削除して template を再コピー
  if (existsSync(runtimeDir)) {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
  mkdirSync(runtimeDir, { recursive: true })
  cpSync(templateDir, runtimeDir, { recursive: true, force: false })

  // モデルを復元
  if (hasBackup) {
    const newModelsDir = path.join(
      runtimeDir,
      'node_modules',
      'nodejs-whisper',
      'cpp',
      'whisper.cpp',
      'models',
    )
    try {
      mkdirSync(newModelsDir, { recursive: true })
      cpSync(backupDir, newModelsDir, { recursive: true })
      rmSync(backupDir, { recursive: true, force: true })
      console.log('[electron] restored downloaded Whisper models')
    } catch (e) {
      console.warn('[electron] model restore failed (backup kept at:', backupDir, '):', e)
    }
  }
}

/**
 * Ollama を sidecar として起動する。
 * - 既存の Ollama (brew や Ollama.app 等) が動いていれば検出して再利用
 * - 動いていなければ electron-ollama に DL & 起動を任せる
 * - packaged 版では同梱した Llama 3.2 3B を OLLAMA_MODELS 経由で読ませる
 *   (env を spawn 前にセットしておけば electron-ollama の子プロセスが継承する)
 */
async function startOllama(ollamaModelsDir: string | null): Promise<void> {
  const basePath = isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..', '..')

  // packaged: 同梱モデルを置いた writable パスを Ollama に教える。
  // この env は ElectronOllama が spawn する `ollama serve` 子プロセスに継承される。
  // dev: ユーザーの ~/.ollama を使わせるため OLLAMA_MODELS は設定しない。
  if (ollamaModelsDir) {
    process.env.OLLAMA_MODELS = ollamaModelsDir
    console.log(`[ollama] OLLAMA_MODELS=${ollamaModelsDir}`)
  }

  ollamaManager = new ElectronOllama({ basePath })

  if (await ollamaManager.isRunning()) {
    console.log('[ollama] existing instance detected; reusing it')
    return
  }

  // pin した OLLAMA_VERSION でローカルバイナリの有無を確認する。
  // getMetadata('latest')(GitHub API = ネット必須)を避けるのがオフライン化の肝。
  // 同梱バイナリの userData コピーが効いていれば isDownloaded=true になり、
  // serve() は getMetadata も DL も呼ばずにローカルバイナリを spawn するだけになる。
  const downloaded = await ollamaManager.isDownloaded(OLLAMA_VERSION)
  if (downloaded) {
    console.log(`[ollama] starting bundled Ollama ${OLLAMA_VERSION} (offline, no network)`)
  } else {
    // フォールバック: 同梱コピーが無い/壊れている想定外ケース。
    // serve() が内部で getMetadata + download に落ちる(オフラインなら失敗するが、
    // それは同梱バイナリが欠落している異常時のみ)。
    console.warn(
      `[ollama] bundled binary for ${OLLAMA_VERSION} not found; ` +
        `serve() will fall back to network download (requires internet)`,
    )
  }
  await ollamaManager.serve(OLLAMA_VERSION, {
    timeoutSec: OLLAMA_SERVE_TIMEOUT_SEC,
    serverLog: (msg) => process.stdout.write(`[ollama] ${msg}`),
    downloadLog: (percent, msg) => {
      console.log(`[ollama:download ${percent}%] ${msg}`)
    },
  })
}

async function startBackend(layout: RuntimeLayout): Promise<void> {
  // 同梱の ffmpeg-static を PATH の先頭に追加して、nodejs-whisper の
  // `spawn('ffmpeg', ...)` が確実にバンドル版を拾うようにする。
  // ユーザー Mac に Homebrew や ffmpeg が無くても OK。
  const augmentedPath = layout.ffmpegDir
    ? `${layout.ffmpegDir}:${process.env.PATH ?? ''}`
    : (process.env.PATH ?? '')
  if (!layout.ffmpegDir) {
    console.warn('[electron] bundled ffmpeg not found; will rely on system PATH ffmpeg')
  } else {
    console.log(`[electron] using bundled ffmpeg at ${layout.ffmpegDir}`)
  }

  // Electron 実行ファイル自体を Node として使う(spawn 用に同梱の Node が不要)
  backendProc = spawn(process.execPath, [layout.entryPath], {
    cwd: layout.runtimeDir,
    env: {
      ...process.env,
      PATH: augmentedPath,
      PORT: String(BACKEND_PORT),
      HOST: BACKEND_HOST,
      SPEAKY_FRONTEND_PATH: layout.frontendDist,
      SPEAKY_WHISPER_BASE_DIR: layout.whisperPackageDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  backendProc.stdout?.on('data', (b: Buffer) => {
    process.stdout.write(`[backend] ${b.toString()}`)
  })
  backendProc.stderr?.on('data', (b: Buffer) => {
    process.stderr.write(`[backend] ${b.toString()}`)
  })
  backendProc.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`)
    backendProc = null
  })

  await waitForBackend()
}

async function waitForBackend(maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/health`)
      if (res.ok) {
        console.log('[electron] backend is ready')
        return
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Backend did not become ready within ${maxAttempts * 250}ms`)
}

/**
 * セットアップ用の小さなスプラッシュウィンドウ。
 * 初回起動の cpSync (~30〜60 秒) の間、ユーザーに「何が起きているか」を伝える。
 * frameless / 480x320 / resize 不可。
 */
function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    title: 'Speaky をセットアップ中',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  void win.loadFile(path.join(__dirname, 'splash.html'))
  return win
}

/**
 * スプラッシュ DOM の #error にメッセージを表示する。
 * 失敗時はサイレントに諦める(あくまでベストエフォート)。
 */
function showSplashError(win: BrowserWindow, message: string): void {
  if (win.isDestroyed()) return
  // JSON.stringify でエスケープを賄う。
  const js = `
    (() => {
      const el = document.getElementById('error');
      const status = document.getElementById('status');
      if (el) {
        el.textContent = ${JSON.stringify(message)};
        el.classList.add('error--visible');
      }
      if (status) {
        status.textContent = 'セットアップに失敗しました';
      }
    })();
  `
  win.webContents.executeJavaScript(js).catch(() => {
    // ignore
  })
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'Speaky',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 外部リンクは OS の既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (loadBuild) {
    // backend が同じ origin で frontend を serve しているのでこれを開く
    void win.loadURL(BACKEND_ORIGIN)
  } else {
    // dev: Vite dev server に接続(別ターミナルで npm run dev:backend と dev:frontend)
    void win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}

app
  .whenReady()
  .then(async () => {
    // planRuntime() でパス計算と needsSync 判定だけ行う(実コピーはまだ走らせない)。
    // packaged + needsSync の時のみスプラッシュを先に出して、UI スレッドを返してから
    // 重い cpSync を setImmediate で実行する。dev/2 回目以降は今まで通り即メインウィンドウ。
    let layout: RuntimeLayout | null = null
    let splash: BrowserWindow | null = null
    if (loadBuild) {
      let plan: RuntimePlan
      try {
        plan = planRuntime()
      } catch (e) {
        console.error('[electron] runtime plan failed:', e)
        app.quit()
        return
      }
      layout = plan.layout

      if (plan.needsSync && plan.sync) {
        const sync = plan.sync
        splash = createSplashWindow()
        try {
          await new Promise<void>((resolveSync, rejectSync) => {
            // ウィンドウ描画を 1 ティック待ってから重い cpSync を走らせる。
            setImmediate(() => {
              try {
                runRuntimeSync(sync)
                resolveSync()
              } catch (e) {
                rejectSync(e as Error)
              }
            })
          })
        } catch (e) {
          console.error('[electron] runtime sync failed:', e)
          if (splash && !splash.isDestroyed()) {
            const msg = e instanceof Error ? e.message : String(e)
            showSplashError(splash, msg)
            // スプラッシュにエラーを見せる時間を確保してから quit
            // 注意: この時点では ollamaManager/backendProc どちらも未生成のため
            //       before-quit ハンドラでの後始末は不要。startup 順序を変える時は再検討すること。
            setTimeout(() => app.quit(), 6_000)
          } else {
            app.quit()
          }
          return
        }
      }
    }

    // backend より先に Ollama sidecar を起動する。
    // dev モード(vite dev server + 別ターミナルの dev:backend)でも、
    // backend は Ollama に依存するため sidecar 起動を走らせる。
    // packaged 時は同梱モデルのある OLLAMA_MODELS を指定する。
    try {
      await startOllama(layout?.ollamaModelsDir ?? null)
    } catch (e) {
      console.error('[electron] failed to start Ollama:', e)
      if (splash && !splash.isDestroyed()) {
        showSplashError(splash, `Ollama の起動に失敗しました: ${(e as Error).message}`)
        setTimeout(() => app.quit(), 6_000)
      } else {
        app.quit()
      }
      return
    }

    if (loadBuild && layout) {
      if (!existsSync(layout.entryPath) || !existsSync(layout.frontendDist)) {
        console.error('[electron] backend/frontend build not found.')
        console.error('  Run: npm run build (from project root) before npm run dev:packaged')
        app.quit()
        return
      }
      try {
        await startBackend(layout)
      } catch (e) {
        console.error('[electron] failed to start backend:', e)
        if (splash && !splash.isDestroyed()) {
          showSplashError(splash, `バックエンドの起動に失敗しました: ${(e as Error).message}`)
          setTimeout(() => app.quit(), 6_000)
        } else {
          app.quit()
        }
        return
      }
    }

    const mainWin = createMainWindow()

    // メインウィンドウの描画準備が整ってからスプラッシュを閉じる。
    // loadURL の前にすぐ splash.close() すると「splash 閉じる → 真っ白」が一瞬出るため、
    // ready-to-show を待ってチラつきを防ぐ。
    if (splash && !splash.isDestroyed()) {
      const closeSplash = () => {
        if (splash && !splash.isDestroyed()) splash.close()
      }
      mainWin.once('ready-to-show', closeSplash)
      // フォールバック: 何らかの理由で ready-to-show が来ない場合に備えて 10 秒で強制 close
      setTimeout(closeSplash, 10_000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })
  .catch((e) => {
    console.error('[electron] startup error:', e)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (backendProc) {
    console.log('[electron] killing backend process')
    backendProc.kill('SIGTERM')
    backendProc = null
  }
  // electron-ollama が serve() で起動したサーバだけ停止する。
  // 既存 Ollama を検出して再利用したケース(getServer() === null)では何もしない。
  const server = ollamaManager?.getServer()
  if (server) {
    event.preventDefault()
    // stop() がハングしてもアプリが終了不能にならないようタイムアウトを噛ませる。
    const stopWithTimeout = Promise.race([
      server.stop(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`stop timeout after ${OLLAMA_STOP_TIMEOUT_MS}ms`)),
          OLLAMA_STOP_TIMEOUT_MS,
        ),
      ),
    ])
    stopWithTimeout
      .catch((e) => console.warn('[ollama] stop failed or timed out:', e))
      .finally(() => {
        ollamaManager = null
        app.quit()
      })
  }
})

import { app, BrowserWindow, shell } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const BACKEND_PORT = 3001
const BACKEND_HOST = '127.0.0.1'
const BACKEND_ORIGIN = `http://${BACKEND_HOST}:${BACKEND_PORT}`

const isPackaged = app.isPackaged
// 開発時に「ビルド済み frontend + spawn backend」を試すモード
const loadBuild = isPackaged || process.env.SPEAKY_LOAD_BUILD === '1'

let backendProc: ChildProcess | null = null

interface RuntimeLayout {
  entryPath: string
  /** spawn の cwd。backend が process.cwd()/node_modules/nodejs-whisper を解決できる位置 */
  runtimeDir: string
  frontendDist: string
  /** SPEAKY_WHISPER_BASE_DIR に渡す絶対パス。writable であること */
  whisperPackageDir: string
}

/**
 * packaged: process.resourcesPath/backend-template/* を userData/backend-runtime/ にコピー(初回のみ)
 *   .app/Contents/Resources は read-only なので、Whisper モデル DL や whisper.cpp ビルドの
 *   書き込み先として直接使えない。書き込み可能な userData にコピーして cwd を固定する。
 *
 * dev:packaged: workspace のパスをそのまま使う(root の node_modules は writable)
 */
function setupRuntime(): RuntimeLayout {
  if (!isPackaged) {
    const workspaceRoot = path.resolve(__dirname, '..', '..')
    return {
      entryPath: path.join(workspaceRoot, 'backend', 'dist', 'index.js'),
      runtimeDir: path.join(workspaceRoot, 'backend', 'dist'),
      frontendDist: path.join(workspaceRoot, 'frontend', 'dist'),
      whisperPackageDir: path.join(workspaceRoot, 'node_modules', 'nodejs-whisper'),
    }
  }

  const userData = app.getPath('userData')
  const runtimeDir = path.join(userData, 'backend-runtime')
  const entryPath = path.join(runtimeDir, 'index.cjs')
  const whisperPackageDir = path.join(runtimeDir, 'node_modules', 'nodejs-whisper')
  const templateDir = path.join(process.resourcesPath, 'backend-template')

  if (!existsSync(templateDir)) {
    throw new Error(`backend-template not found at ${templateDir}. Bundle is broken.`)
  }

  // 「現在のアプリ版で同期した runtime か?」を version.json で記録。
  // アプリ更新で版が変わったら、ユーザーDLしたモデルを保護したうえで
  // backend コード+vendor を template から再同期する。
  const VERSION_FILE = path.join(runtimeDir, 'version.json')
  const currentVersion = app.getVersion()

  let storedVersion: string | null = null
  if (existsSync(VERSION_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(VERSION_FILE, 'utf-8')) as { version?: string }
      storedVersion = parsed.version ?? null
    } catch {
      storedVersion = null
    }
  }

  const needsSync = !existsSync(entryPath) || storedVersion !== currentVersion

  if (needsSync) {
    console.log(
      `[electron] runtime sync needed: stored=${storedVersion ?? 'none'} current=${currentVersion}`,
    )
    syncRuntime(templateDir, runtimeDir)
    writeFileSync(VERSION_FILE, JSON.stringify({ version: currentVersion }, null, 2))
    console.log(`[electron] runtime synced to ${currentVersion}`)
  }

  return {
    entryPath,
    runtimeDir,
    frontendDist: path.join(process.resourcesPath, 'frontend-dist'),
    whisperPackageDir,
  }
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

async function startBackend(layout: RuntimeLayout): Promise<void> {
  // Electron 実行ファイル自体を Node として使う(spawn 用に同梱の Node が不要)
  backendProc = spawn(process.execPath, [layout.entryPath], {
    cwd: layout.runtimeDir,
    env: {
      ...process.env,
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
    if (loadBuild) {
      let layout: RuntimeLayout
      try {
        layout = setupRuntime()
      } catch (e) {
        console.error('[electron] runtime setup failed:', e)
        app.quit()
        return
      }
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
        app.quit()
        return
      }
    }
    createMainWindow()

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

app.on('before-quit', () => {
  if (backendProc) {
    console.log('[electron] killing backend process')
    backendProc.kill('SIGTERM')
    backendProc = null
  }
})

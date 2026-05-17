import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'

const isDev = !app.isPackaged

// Stage 1 では「ウィンドウが開く」ことだけを確認する。
// Stage 2 で frontend の本番ビルドをロード、Stage 3 で backend を spawn する。
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

  if (isDev) {
    // dev: Vite dev server に接続(別ターミナルで npm run dev:frontend 起動が前提)
    void win.loadURL('http://localhost:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    // prod: ビルドした frontend を file:// で読み込む(Stage 2 で実装)
    void win.loadFile(path.join(__dirname, '..', 'frontend-dist', 'index.html'))
  }

  return win
}

app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    // macOS: dock からの再起動で window が無ければ作り直す
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

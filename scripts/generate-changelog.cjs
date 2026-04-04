/**
 * 自動生成版本更新記錄腳本
 * 在構建前執行，從 git log 提取提交記錄並生成 JSON 檔案
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// 設定
const OUTPUT_DIR = path.join(__dirname, '../src/data')
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'changelog.json')
const DAYS_TO_INCLUDE = 90 // 包含最近 90 天的記錄

// 解析提交類型
function parseCommitType(message) {
  const typeMap = {
    feat: { type: 'feat', label: '新增' },
    fix: { type: 'fix', label: '修正' },
    docs: { type: 'docs', label: '文件' },
    refactor: { type: 'refactor', label: '重構' },
    style: { type: 'style', label: '樣式' },
    perf: { type: 'perf', label: '效能' },
    chore: { type: 'chore', label: '維護' },
  }

  // 解析 conventional commit 格式
  const match = message.match(/^(feat|fix|docs|refactor|style|perf|chore)(\(.+\))?:\s*(.+)$/i)
  if (match) {
    const type = match[1].toLowerCase()
    const text = match[3].trim()
    return {
      ...typeMap[type],
      text,
    }
  }

  // 嘗試匹配中文前綴
  const cnMatch = message.match(/^(新增|修正|修復|更新|優化|重構|移除|調整)[：:]\s*(.+)$/i)
  if (cnMatch) {
    const cnTypeMap = {
      新增: 'feat',
      修正: 'fix',
      修復: 'fix',
      更新: 'feat',
      優化: 'perf',
      重構: 'refactor',
      移除: 'chore',
      調整: 'fix',
    }
    return {
      type: cnTypeMap[cnMatch[1]] || 'chore',
      text: cnMatch[2].trim(),
    }
  }

  // 預設為 chore
  return {
    type: 'chore',
    text: message,
  }
}

// 生成日期標題
function generateTitle(changes) {
  // 統計各類型數量
  const featCount = changes.filter((c) => c.type === 'feat').length
  const fixCount = changes.filter((c) => c.type === 'fix').length

  if (featCount > 0 && fixCount > 0) {
    return `功能更新與問題修正`
  } else if (featCount > 0) {
    return `新功能發布`
  } else if (fixCount > 0) {
    return `問題修正`
  }
  return `版本更新`
}

// 主函數
function generateChangelog() {
  console.log('正在生成版本更新記錄...')

  // 確保輸出目錄存在
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }

  // 計算日期範圍
  const sinceDate = new Date()
  sinceDate.setDate(sinceDate.getDate() - DAYS_TO_INCLUDE)
  const sinceDateStr = sinceDate.toISOString().split('T')[0]

  // 執行 git log
  let gitOutput
  try {
    gitOutput = execSync(
      `git log --since="${sinceDateStr}" --pretty=format:"%H|%ad|%s" --date=short`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )
  } catch (error) {
    console.error('執行 git log 失敗:', error.message)
    // 如果失敗，創建空的 changelog
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2))
    return
  }

  if (!gitOutput.trim()) {
    console.log('沒有找到最近的提交記錄')
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify([], null, 2))
    return
  }

  // 解析提交記錄
  const commits = gitOutput
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [hash, date, ...messageParts] = line.split('|')
      const message = messageParts.join('|')
      return { hash, date, message }
    })
    // 過濾掉 merge commits
    .filter((c) => !c.message.toLowerCase().startsWith('merge'))

  // 按日期分組
  const groupedByDate = {}
  commits.forEach((commit) => {
    if (!groupedByDate[commit.date]) {
      groupedByDate[commit.date] = []
    }
    const parsed = parseCommitType(commit.message)
    // 避免重複
    const exists = groupedByDate[commit.date].some((c) => c.text === parsed.text)
    if (!exists) {
      groupedByDate[commit.date].push(parsed)
    }
  })

  // 轉換為陣列格式並排序
  const changelog = Object.entries(groupedByDate)
    .map(([date, changes]) => ({
      version: date,
      title: generateTitle(changes),
      changes: changes.filter((c) => c.type === 'feat' || c.type === 'fix'), // 只保留 feat 和 fix
    }))
    .filter((entry) => entry.changes.length > 0) // 過濾掉沒有 feat/fix 的日期
    .sort((a, b) => b.version.localeCompare(a.version)) // 按日期降序
    .slice(0, 30) // 最多保留 30 個版本

  // 寫入 JSON 檔案
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(changelog, null, 2))

  console.log(`已生成版本更新記錄: ${OUTPUT_FILE}`)
  console.log(`共 ${changelog.length} 個版本，${changelog.reduce((sum, c) => sum + c.changes.length, 0)} 筆更新記錄`)
}

// 執行
generateChangelog()

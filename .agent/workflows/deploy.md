---
description: 部署 Angular 應用到 Firebase Hosting（測試版/正式版）
---

# 部署流程

兩種部署模式都使用 **production** 建置（連線正式 Firebase 後端 `dialysis-schedule-cd36c`）。

## 測試版部署（開發網址）

production 建置 → 部署到 `my-dialysis-app-develop` hosting

// turbo
1. 建置 production：
```
npx ng build -c production
```

// turbo
2. 部署到開發版 hosting：
```
npx firebase deploy --only hosting
```

部署完成後網址：https://my-dialysis-app-develop.web.app

---

## 正式版部署（正式網址）

production 建置 → 部署到 `dialysis-schedule-cd36c` hosting

// turbo
1. 建置 production：
```
npx ng build -c production
```

// turbo
2. 部署到正式版 hosting：
```
npx firebase deploy --only hosting --project production
```

部署完成後網址：https://dialysis-schedule-cd36c.web.app

---

## 其他部署

// turbo
- 部署 Functions：`npm run deploy:functions`

### ⚠️ 部署 Firestore Rules（重要！）

**Angular 版本不管測試版或正式版，都使用 production 專案 (`dialysis-schedule-cd36c`) 的 Firestore 資料庫。**
所以部署 Firestore Rules 時，**一律必須部署到 production 專案**：

// turbo
```
npx firebase deploy --only firestore:rules --project dialysis-schedule-cd36c
```

> ❌ 不要用 `npx firebase deploy --only firestore:rules`（預設會到 develop，但資料庫不在那裡）

## 注意事項
- 兩個版本都使用 `ng build -c production`（連到正式 Firebase 後端）
- `.firebaserc` 中 `default` = `my-dialysis-app-develop`，`production` = `dialysis-schedule-cd36c`
- 測試版 Hosting 不需指定 `--project`（自動使用 default）
- 正式版 Hosting 需指定 `--project production`
- **Firestore 資料庫**：兩版共用 production，Rules 一律部署到 `--project dialysis-schedule-cd36c`

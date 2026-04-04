module.exports = {
  root: true,
  env: {
    es6: true,
    node: true, // <-- 【核心修改】告訴 ESLint 這是 Node.js 環境
  },
  extends: ['eslint:recommended', 'google'],
  rules: {
    quotes: ['error', 'double'],
  },
}

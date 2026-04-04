import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import changelogData from '@/data/changelog.json';

interface PageGuide {
  name: string;
  path: string;
  roles: string;
  icon: string;
  description: string;
  features: { title: string; desc: string }[];
}

interface Section {
  id: string;
  name: string;
  icon: string;
}

@Component({
  selector: 'app-usage-guide',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './usage-guide.component.html',
  styleUrl: './usage-guide.component.css',
})
export class UsageGuideComponent {
  activeSection = signal('overview');
  expandedPages = signal<Record<string, boolean>>({});
  changelog: any[] = changelogData;

  sections: Section[] = [
    { id: 'overview', name: '平台總覽', icon: 'fa-home' },
    { id: 'common', name: '共用功能', icon: 'fa-users' },
    { id: 'admin-editor', name: '排班管理', icon: 'fa-calendar-alt' },
    { id: 'backend', name: '後臺管理', icon: 'fa-cog' },
    { id: 'changelog', name: '版本更新', icon: 'fa-history' },
  ];

  pageGuides: Record<string, PageGuide> = {
    schedule: {
      name: '每日排程',
      path: '/schedule',
      roles: '所有使用者',
      icon: 'fa-calendar-day',
      description: '查看與管理當日透析病人的排班安排',
      features: [
        { title: '拖曳排床', desc: '將病人卡片拖曳到目標床位即可完成排床' },
        { title: '智慧排床', desc: '點擊工具列的「智慧排床」按鈕，系統自動為未排床病人安排適合床位' },
        { title: '自動分組', desc: '根據護理班表自動分配護理分組' },
        { title: 'ICU 醫囑查詢', desc: '點擊住院/急診病人可查看 ICU 系統的最新醫囑' },
        { title: '臨床查閱模式', desc: '切換至簡潔的臨床查閱介面，顯示病歷號和床號' },
        { title: 'Excel 匯出', desc: '將當日排程表匯出為 Excel 檔案' },
      ],
    },
    stats: {
      name: '護理分組',
      path: '/stats',
      roles: '所有使用者',
      icon: 'fa-users-cog',
      description: '查看每日護理分組分配情況，進行交辦與調班申請',
      features: [
        { title: '分組檢視', desc: '依班別（早/中/晚）查看護理師分組與負責病人' },
        { title: '新增交辦', desc: '為特定病人建立待辦事項，交班提醒' },
        { title: '調班申請', desc: '快速建立調班或換床申請' },
        { title: '預約變更', desc: '預約病人屬性或排班規則的未來變更' },
        { title: '夜班收針分組', desc: '顯示 311 夜班的收針分組安排' },
        { title: '自動分組', desc: '一鍵自動分配當日護理分組' },
      ],
    },
    myPatients: {
      name: '我的今日病人',
      path: '/my-patients',
      roles: '所有使用者（護理師專用）',
      icon: 'fa-user-nurse',
      description: '護理師專屬頁面，顯示當日分配給自己的病人清單',
      features: [
        { title: '病人清單', desc: '顯示今日分配給您負責的所有病人' },
        { title: '交班備忘查詢', desc: '快速查看每位病人的待處理交班事項' },
        { title: '用戶篩選', desc: '管理者可切換查看其他護理師的病人' },
        { title: '日期篩選', desc: '查看歷史日期的分配記錄' },
        { title: '快速整理', desc: '一鍵整理顯示格式' },
      ],
    },
    collaboration: {
      name: '訊息中心',
      path: '/collaboration',
      roles: '所有使用者',
      icon: 'fa-comments',
      description: '協作訊息中心，查看和管理病人相關的交辦與留言',
      features: [
        { title: '全部病人', desc: '查看所有病人的訊息與待辦事項' },
        { title: '今日負責', desc: '只顯示今日分配給您的病人' },
        { title: '班別篩選', desc: '依早/中/晚班篩選病人' },
        { title: '新增交辦', desc: '為病人建立新的待辦交辦事項' },
        { title: '新增留言', desc: '在病人頁面留下備註或訊息' },
        { title: '實時更新', desc: '訊息會即時同步，無需手動刷新' },
      ],
    },
    weekly: {
      name: '週排班',
      path: '/weekly',
      roles: '管理員、編輯者',
      icon: 'fa-calendar-week',
      description: '管理一週的透析排班總覽',
      features: [
        { title: '七天總覽', desc: '一次查看週一到週六的完整排班' },
        { title: '患者搜尋', desc: '快速搜尋特定病人的排班位置' },
        { title: '智慧排床', desc: '自動為病人安排一週的床位' },
        { title: '排程檢視', desc: '切換不同的檢視模式' },
        { title: '變更保存', desc: '批次保存所有排班變更' },
        { title: 'Excel 匯出', desc: '匯出週排班表' },
      ],
    },
    baseSchedule: {
      name: '床位總表',
      path: '/base-schedule',
      roles: '管理員、編輯者',
      icon: 'fa-th',
      description: '門急住床位的完整總表視圖',
      features: [
        { title: '總表視圖', desc: '顯示所有床位的排班狀態' },
        { title: '患者搜尋', desc: '依病人姓名或病歷號搜尋' },
        { title: '智慧排床', desc: '自動安排未排床病人' },
        { title: '排程檢視', desc: '多種檢視模式切換' },
        { title: 'Excel 匯出', desc: '匯出床位總表' },
      ],
    },
    exceptionManager: {
      name: '調班換床',
      path: '/exception-manager',
      roles: '管理員、編輯者',
      icon: 'fa-exchange-alt',
      description: '管理臨時調班、區間暫停透析、臨時加洗等例外情況',
      features: [
        { title: '日曆視圖', desc: '以月曆或週曆形式查看所有調班記錄' },
        { title: '月/週切換', desc: '在月視圖和週視圖間切換' },
        { title: '新增調班', desc: '建立新的調班或換床申請' },
        { title: '區間暫停', desc: '設定病人在特定期間暫停透析' },
        { title: '臨時加洗', desc: '為病人安排臨時加洗' },
        { title: '衝突提示', desc: '側邊欄紅點提醒有待解決的衝突' },
        { title: '批次整併', desc: '支援一次整併多筆調班申請' },
      ],
    },
    updateScheduler: {
      name: '預約變更',
      path: '/update-scheduler',
      roles: '管理員、編輯者',
      icon: 'fa-clock',
      description: '預約病人屬性或排班規則的未來變更，到期自動生效',
      features: [
        { title: '變更總覽', desc: '查看所有待生效的預約變更' },
        { title: '新增變更', desc: '建立新的預約變更項目' },
        { title: '編輯變更', desc: '修改尚未生效的變更內容' },
        { title: '刪除變更', desc: '取消不需要的預約變更' },
        { title: '自動執行', desc: '系統會在生效日自動套用變更' },
      ],
    },
    patients: {
      name: '病人清單',
      path: '/patients',
      roles: '管理員、編輯者、貢獻者',
      icon: 'fa-hospital-user',
      description: '管理所有透析病人的基本資料',
      features: [
        { title: '分類頁籤', desc: '依 OPD（門診）、IPD（住院）、ER（急診）分類查看' },
        { title: '新增病人', desc: '建立新的病人資料' },
        { title: '編輯病人', desc: '修改病人的基本資料與排班設定' },
        { title: '刪除病人', desc: '將病人標記為已刪除（可還原）' },
        { title: '醫囑管理', desc: '查看與管理病人的透析醫囑' },
        { title: '病人歷史', desc: '查詢病人的歷史變更記錄' },
        { title: 'Excel 導入', desc: '批次匯入病人資料' },
        { title: 'Excel 導出', desc: '匯出病人清單' },
      ],
    },
    dailyLog: {
      name: '工作日誌',
      path: '/daily-log',
      roles: '管理員、編輯者、查看者',
      icon: 'fa-book',
      description: '記錄每日營運統計、病人異常事件與醫療事項',
      features: [
        { title: '每日統計', desc: '記錄當日透析人次、異常狀況統計' },
        { title: '病人異常', desc: '記錄病人的特殊狀況或事件' },
        { title: '醫療事項', desc: '記錄重要的醫療處置或通知' },
        { title: '組長交班', desc: '護理組長的交班備註' },
        { title: '公告設定', desc: '設定跑馬燈公告內容' },
        { title: 'PDF 導出', desc: '將工作日誌匯出為 PDF 檔案' },
      ],
    },
    nursingSchedule: {
      name: '護理班表與職責',
      path: '/nursing-schedule',
      roles: '管理員、編輯者',
      icon: 'fa-user-clock',
      description: '管理護理師的班表與工作職責分配',
      features: [
        { title: '當月總班表', desc: '查看當月所有護理師的完整班表' },
        { title: '當月週班表', desc: '以週為單位查看班表' },
        { title: '護理工作職責', desc: '查看各護理師的職責分配' },
        { title: '月份選擇', desc: '切換不同月份的班表' },
        { title: 'Excel 上傳', desc: '透過 Excel 匯入班表資料' },
        { title: '組別配置', desc: '設定護理分組的配置規則' },
      ],
    },
    kiditReport: {
      name: 'KiDit 申報',
      path: '/kidit-report',
      roles: '管理員、編輯者',
      icon: 'fa-file-invoice',
      description: 'KiDit 申報工作站，管理透析申報記錄',
      features: [
        { title: '月曆視圖', desc: '以月曆形式查看申報記錄' },
        { title: '月份導航', desc: '切換不同月份查看' },
        { title: '新增記錄', desc: '建立新的申報記錄' },
        { title: '編輯記錄', desc: '修改現有的申報內容' },
        { title: 'CSV 導出', desc: '匯出申報資料為 CSV 格式' },
      ],
    },
    physicianSchedule: {
      name: '醫師班表',
      path: '/physician-schedule',
      roles: '管理員、貢獻者、查看者',
      icon: 'fa-user-md',
      description: '管理醫師的查房、會診與緊急出勤班表',
      features: [
        { title: '查房班表', desc: '查看醫師的例行查房排班' },
        { title: '會診班表', desc: '查看會診醫師的排班' },
        { title: '緊急出勤', desc: '查看緊急情況的值班醫師' },
        { title: '月份導航', desc: '切換不同月份查看' },
        { title: '行動版支援', desc: '支援手機和平板查看' },
      ],
    },
    labReports: {
      name: '檢驗報告',
      path: '/lab-reports',
      roles: '管理員、貢獻者',
      icon: 'fa-flask',
      description: '管理病人的檢驗報告資料',
      features: [
        { title: '頻率查詢', desc: '依檢驗頻率篩選報告' },
        { title: '班別查詢', desc: '依透析班別篩選' },
        { title: '個人查詢', desc: '查詢特定病人的所有報告' },
        { title: '警示報告', desc: '異常數值會特別標示' },
        { title: 'Excel 上傳', desc: '批次匯入檢驗報告' },
        { title: 'Excel 下載', desc: '匯出檢驗報告資料' },
      ],
    },
    consumables: {
      name: '每月耗材',
      path: '/consumables',
      roles: '管理員、查看者',
      icon: 'fa-boxes',
      description: '查看每月透析耗材的使用統計',
      features: [
        { title: '分組查詢', desc: '依護理分組查看耗材使用' },
        { title: '病患查詢', desc: '查詢特定病人的耗材使用' },
        { title: '耗材上傳', desc: '上傳耗材使用記錄' },
        { title: 'Excel 導出', desc: '匯出耗材統計報表' },
      ],
    },
    orders: {
      name: '藥囑管理',
      path: '/orders',
      roles: '管理員、貢獻者',
      icon: 'fa-pills',
      description: '管理病人的口服藥與針劑藥囑',
      features: [
        { title: '群組搜尋', desc: '依分組查看所有病人藥囑' },
        { title: '個人搜尋', desc: '查詢特定病人的藥囑' },
        { title: '年份選擇', desc: '切換不同年份查看' },
        { title: 'Excel 上傳', desc: '批次匯入藥囑資料' },
        { title: 'Excel 導出', desc: '匯出藥囑清單' },
      ],
    },
    reporting: {
      name: '統計報表',
      path: '/reporting',
      roles: '管理員、編輯者、貢獻者',
      icon: 'fa-chart-bar',
      description: '生成各類統計報表',
      features: [
        { title: '日報表', desc: '每日透析人次統計' },
        { title: '月報表', desc: '月度透析人次統計' },
        { title: '年報表', desc: '年度統計數據' },
        { title: '護理人力月報', desc: '護理師工作量統計' },
        { title: 'Excel 導出', desc: '匯出各類報表' },
      ],
    },
    userManagement: {
      name: '使用者管理',
      path: '/user-management',
      roles: '僅管理員',
      icon: 'fa-users-cog',
      description: '管理平台使用者帳號與權限',
      features: [
        { title: '新增使用者', desc: '建立新的使用者帳號' },
        { title: '編輯使用者', desc: '修改使用者資料與權限' },
        { title: '刪除使用者', desc: '停用或刪除使用者帳號' },
        { title: '角色分配', desc: '設定使用者的角色權限' },
        { title: '過期帳戶', desc: '管理過期或停用的帳戶' },
        { title: '強制同步', desc: '強制同步使用者資料' },
        { title: 'Google Drive', desc: '上傳資料至 Google Drive 備份' },
      ],
    },
  };

  // Section to page keys mapping
  commonPages = ['schedule', 'stats', 'myPatients', 'collaboration'];
  adminEditorPages = ['weekly', 'baseSchedule', 'exceptionManager', 'updateScheduler', 'patients'];
  backendPages = [
    'dailyLog',
    'nursingSchedule',
    'kiditReport',
    'physicianSchedule',
    'labReports',
    'consumables',
    'orders',
    'reporting',
    'userManagement',
  ];

  togglePage(pageKey: string): void {
    this.expandedPages.update((pages) => ({
      ...pages,
      [pageKey]: !pages[pageKey],
    }));
  }

  isExpanded(pageKey: string): boolean {
    return !!this.expandedPages()[pageKey];
  }

  getTypeColor(type: string): string {
    switch (type) {
      case 'feat':
        return '#10b981';
      case 'fix':
        return '#f59e0b';
      case 'docs':
        return '#3b82f6';
      case 'refactor':
        return '#8b5cf6';
      default:
        return '#6b7280';
    }
  }

  getTypeLabel(type: string): string {
    switch (type) {
      case 'feat':
        return '新增';
      case 'fix':
        return '修正';
      case 'docs':
        return '文件';
      case 'refactor':
        return '重構';
      default:
        return '其他';
    }
  }
}

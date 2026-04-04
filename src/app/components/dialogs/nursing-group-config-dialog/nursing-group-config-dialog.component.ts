import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '@services/auth.service';
import { UserDirectoryService, DirectoryUser } from '@services/user-directory.service';
import {
  fetchNursingGroupConfig,
  saveNursingGroupConfig,
  getDefaultConfig,
  validateConfig,
  generateDayShiftGroups,
  generateNightShiftGroups,
  calculate74Groups,
  MAX_DAY_SHIFT_GROUPS,
  MAX_NIGHT_SHIFT_GROUPS,
} from '@/services/nursingGroupConfigService';

@Component({
  selector: 'app-nursing-group-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './nursing-group-config-dialog.component.html',
  styleUrl: './nursing-group-config-dialog.component.css'
})
export class NursingGroupConfigDialogComponent implements OnChanges, OnInit {
  private readonly auth = inject(AuthService);
  private readonly userDirectory = inject(UserDirectoryService);

  @Input() modelValue = false;
  @Input() yearMonth = '';
  @Output() visibilityChange = new EventEmitter<boolean>();
  @Output() saved = new EventEmitter<any>();

  isLoading = true;
  isSaving = false;
  statusMessage: { type: string; text: string } | null = null;
  nurseSearchQuery = '';
  excludedNurseSearchQuery = '';
  config: any = getDefaultConfig();
  sourceMonth: string | null = null;
  newRestrictionNurseId = '';
  newRestrictionGroups: string[] = [];

  // Arrays for template iteration
  maxDayShiftGroupsArray: number[] = [];
  maxNightShiftGroupsArray: number[] = [];

  ngOnInit(): void {
    this.maxDayShiftGroupsArray = Array.from({ length: MAX_DAY_SHIFT_GROUPS }, (_, i) => i + 1);
    this.maxNightShiftGroupsArray = Array.from({ length: MAX_NIGHT_SHIFT_GROUPS }, (_, i) => i + 1);
    this.userDirectory.ensureUsersLoaded();
  }

  get dayGroups135(): string[] {
    return generateDayShiftGroups(this.config.groupCounts?.['135']?.dayShiftCount || 8);
  }

  get dayGroups246(): string[] {
    return generateDayShiftGroups(this.config.groupCounts?.['246']?.dayShiftCount || 9);
  }

  get nightGroups135(): string[] {
    return generateNightShiftGroups(this.config.groupCounts?.['135']?.nightShiftCount || 9);
  }

  get nightGroups246(): string[] {
    return generateNightShiftGroups(this.config.groupCounts?.['246']?.nightShiftCount || 8);
  }

  get calculated74Groups135(): string[] {
    const dayGroups = this.dayGroups135;
    const shift75Groups = this.config.dayShiftRules?.['135']?.shift75Groups || [];
    return calculate74Groups(dayGroups, shift75Groups);
  }

  get calculated74Groups246(): string[] {
    const dayGroups = this.dayGroups246;
    const shift75Groups = this.config.dayShiftRules?.['246']?.shift75Groups || [];
    return calculate74Groups(dayGroups, shift75Groups);
  }

  get nightShiftGroupOptions(): string[] {
    // Combined unique night shift groups from both 135 and 246
    const set = new Set<string>([...this.nightGroups135, ...this.nightGroups246]);
    return Array.from(set).sort();
  }

  get nurses(): DirectoryUser[] {
    return this.userDirectory.allUsers()
      .filter((user: DirectoryUser) => user.title === '護理師' || user.title === '護理師組長')
      .sort((a: DirectoryUser, b: DirectoryUser) => {
        const nameA = a.name || '';
        const nameB = b.name || '';
        return nameA.localeCompare(nameB, 'zh-TW');
      });
  }

  get filteredNurses(): DirectoryUser[] {
    if (!this.nurseSearchQuery) return this.nurses;
    const q = this.nurseSearchQuery.toLowerCase();
    return this.nurses.filter((nurse: DirectoryUser) => {
      const name = (nurse.name || '').toLowerCase();
      return name.includes(q);
    });
  }

  get filteredNursesForExcluded(): DirectoryUser[] {
    if (!this.excludedNurseSearchQuery) return this.nurses;
    const q = this.excludedNurseSearchQuery.toLowerCase();
    return this.nurses.filter((nurse: DirectoryUser) => {
      const name = (nurse.name || '').toLowerCase();
      return name.includes(q);
    });
  }

  get nightRestrictionList(): { nurseId: string; nurseName: string; groups: string[] }[] {
    const restrictions = this.config.nightShiftRestrictions || {};
    const list: { nurseId: string; nurseName: string; groups: string[] }[] = [];
    Object.entries(restrictions).forEach(([nurseId, groups]: [string, any]) => {
      if (groups && groups.length > 0) {
        const nurse = this.nurses.find((n: DirectoryUser) => n.uid === nurseId);
        list.push({
          nurseId,
          nurseName: nurse?.name || nurseId,
          groups: [...groups].sort(),
        });
      }
    });
    return list.sort((a, b) => a.nurseName.localeCompare(b.nurseName, 'zh-TW'));
  }

  get availableNursesForNightRestriction(): DirectoryUser[] {
    return this.nurses;
  }

  get validationErrors(): string[] {
    const result = validateConfig(this.config);
    return result.errors;
  }

  // --- Checkbox helpers (since Angular doesn't have v-model for checkbox arrays) ---
  isInCannotBeNightLeader(uid: string): boolean {
    return (this.config.cannotBeNightLeader || []).includes(uid);
  }

  toggleCannotBeNightLeader(uid: string): void {
    const arr = this.config.cannotBeNightLeader || [];
    const idx = arr.indexOf(uid);
    if (idx === -1) {
      arr.push(uid);
    } else {
      arr.splice(idx, 1);
    }
    this.config.cannotBeNightLeader = [...arr];
  }

  isInExcludedNurses(uid: string): boolean {
    return (this.config.excludedNurses || []).includes(uid);
  }

  toggleExcludedNurse(uid: string): void {
    const arr = this.config.excludedNurses || [];
    const idx = arr.indexOf(uid);
    if (idx === -1) {
      arr.push(uid);
    } else {
      arr.splice(idx, 1);
    }
    this.config.excludedNurses = [...arr];
  }

  isIn75Groups(weekday: string, group: string): boolean {
    return (this.config.dayShiftRules?.[weekday]?.shift75Groups || []).includes(group);
  }

  toggle75Group(weekday: string, group: string): void {
    if (!this.config.dayShiftRules) this.config.dayShiftRules = {};
    if (!this.config.dayShiftRules[weekday]) this.config.dayShiftRules[weekday] = { shift75Groups: [] };
    const arr = this.config.dayShiftRules[weekday].shift75Groups;
    const idx = arr.indexOf(group);
    if (idx === -1) {
      arr.push(group);
    } else {
      arr.splice(idx, 1);
    }
    this.config.dayShiftRules[weekday].shift75Groups = [...arr];
  }

  isNewRestrictionGroupChecked(group: string): boolean {
    return this.newRestrictionGroups.includes(group);
  }

  toggleNewRestrictionGroup(group: string): void {
    const idx = this.newRestrictionGroups.indexOf(group);
    if (idx === -1) {
      this.newRestrictionGroups.push(group);
    } else {
      this.newRestrictionGroups.splice(idx, 1);
    }
    this.newRestrictionGroups = [...this.newRestrictionGroups];
  }

  onDayCountChange(weekday: string): void {
    // When day shift count changes, remove any 75-group selections that are no longer valid
    const dayGroups = weekday === '135' ? this.dayGroups135 : this.dayGroups246;
    const rules = this.config.dayShiftRules?.[weekday];
    if (rules?.shift75Groups) {
      rules.shift75Groups = rules.shift75Groups.filter((g: string) => dayGroups.includes(g));
    }
  }

  addNightRestriction(): void {
    if (!this.newRestrictionNurseId || this.newRestrictionGroups.length === 0) return;

    if (!this.config.nightShiftRestrictions) {
      this.config.nightShiftRestrictions = {};
    }

    const existing = this.config.nightShiftRestrictions[this.newRestrictionNurseId] || [];
    const merged = new Set([...existing, ...this.newRestrictionGroups]);
    this.config.nightShiftRestrictions[this.newRestrictionNurseId] = Array.from(merged);

    this.newRestrictionNurseId = '';
    this.newRestrictionGroups = [];
  }

  removeNightRestrictionGroup(nurseId: string, group: string): void {
    if (!this.config.nightShiftRestrictions?.[nurseId]) return;
    this.config.nightShiftRestrictions[nurseId] = this.config.nightShiftRestrictions[nurseId].filter(
      (g: string) => g !== group
    );
    if (this.config.nightShiftRestrictions[nurseId].length === 0) {
      delete this.config.nightShiftRestrictions[nurseId];
    }
  }

  removeNightRestriction(nurseId: string): void {
    if (this.config.nightShiftRestrictions) {
      delete this.config.nightShiftRestrictions[nurseId];
      this.config.nightShiftRestrictions = { ...this.config.nightShiftRestrictions };
    }
  }

  async loadConfig(): Promise<void> {
    if (!this.yearMonth) return;
    this.isLoading = true;
    this.statusMessage = null;
    try {
      const result = await fetchNursingGroupConfig(this.yearMonth);
      this.config = result.config;
      this.sourceMonth = result.sourceMonth;

      // Ensure arrays exist
      if (!this.config.cannotBeNightLeader) this.config.cannotBeNightLeader = [];
      if (!this.config.excludedNurses) this.config.excludedNurses = [];
      if (!this.config.nightShiftRestrictions) this.config.nightShiftRestrictions = {};
      if (!this.config.dayShiftRules) {
        this.config.dayShiftRules = {
          '135': { shift75Groups: [] },
          '246': { shift75Groups: [] },
        };
      }
      if (!this.config.dayShiftRules['135']) this.config.dayShiftRules['135'] = { shift75Groups: [] };
      if (!this.config.dayShiftRules['246']) this.config.dayShiftRules['246'] = { shift75Groups: [] };
      if (!this.config.groupCounts) {
        this.config.groupCounts = {
          '135': { dayShiftCount: 8, nightShiftCount: 9 },
          '246': { dayShiftCount: 9, nightShiftCount: 8 },
        };
      }
    } catch (err: any) {
      console.error('Failed to load nursing group config:', err);
      this.statusMessage = { type: 'error', text: err.message || '載入配置失敗' };
      this.config = getDefaultConfig();
    } finally {
      this.isLoading = false;
    }
  }

  async saveConfig(): Promise<void> {
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      this.statusMessage = { type: 'error', text: '請修正驗證錯誤後再儲存' };
      return;
    }

    this.isSaving = true;
    this.statusMessage = null;
    try {
      const currentUser = this.auth.currentUser();
      await saveNursingGroupConfig(this.config, this.yearMonth, currentUser);
      this.sourceMonth = this.yearMonth;
      this.statusMessage = { type: 'success', text: '配置已成功儲存' };
      this.saved.emit(this.config);
    } catch (err: any) {
      console.error('Failed to save nursing group config:', err);
      this.statusMessage = { type: 'error', text: err.message || '儲存失敗' };
    } finally {
      this.isSaving = false;
    }
  }

  resetToDefault(): void {
    if (!confirm('確定要重置為預設配置嗎？這將會清除所有變更。')) return;
    this.config = getDefaultConfig();
    this.statusMessage = { type: 'success', text: '已重置為預設配置' };
  }

  closeDialog(): void {
    this.visibilityChange.emit(false);
    this.statusMessage = null;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['modelValue'] && this.modelValue) {
      this.loadConfig();
    }
  }
}

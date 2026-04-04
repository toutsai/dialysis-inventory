import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AutoAssignConfigService,
  AutoAssignConfig,
  getDefaultAutoAssignConfig,
  ALL_TEAM_LETTERS,
} from '@services/auto-assign-config.service';

@Component({
  selector: 'app-auto-assign-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './auto-assign-config-dialog.component.html',
  styleUrl: './auto-assign-config-dialog.component.css',
})
export class AutoAssignConfigDialogComponent implements OnChanges {
  private readonly configService = inject(AutoAssignConfigService);
  private readonly cdr = inject(ChangeDetectorRef);

  @Input() isVisible = false;
  @Output() closeEvent = new EventEmitter<void>();
  @Output() savedEvent = new EventEmitter<AutoAssignConfig>();

  config: AutoAssignConfig = getDefaultAutoAssignConfig();
  isLoading = true;
  isSaving = false;
  statusMessage: { type: string; text: string } | null = null;

  readonly allTeams = ALL_TEAM_LETTERS;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      this.loadConfig();
    }
  }

  async loadConfig(): Promise<void> {
    this.isLoading = true;
    this.statusMessage = null;
    try {
      this.config = await this.configService.fetchConfig();
      this.config = JSON.parse(JSON.stringify(this.config));
    } catch (err) {
      console.error('Failed to load config:', err);
      this.config = getDefaultAutoAssignConfig();
    } finally {
      this.isLoading = false;
      this.cdr.markForCheck();
    }
  }

  async saveConfig(): Promise<void> {
    this.isSaving = true;
    this.statusMessage = null;
    try {
      // Sync inpatientCapacity keys with inpatientTeams
      this.syncCapacity('earlyShift');
      this.syncCapacity('lateShift');

      await this.configService.saveConfig(this.config);
      this.statusMessage = { type: 'success', text: '設定已儲存' };
      this.savedEvent.emit(this.config);
    } catch (err: any) {
      console.error('Failed to save config:', err);
      this.statusMessage = { type: 'error', text: err.message || '儲存失敗' };
    } finally {
      this.isSaving = false;
      this.cdr.markForCheck();
    }
  }

  resetToDefault(): void {
    if (!confirm('確定要重置為預設設定嗎？')) return;
    this.config = getDefaultAutoAssignConfig();
    this.statusMessage = { type: 'success', text: '已重置為預設值' };
  }

  close(): void {
    this.statusMessage = null;
    this.closeEvent.emit();
  }

  // --- Early shift inpatient team toggles ---
  isEarlyInpatientTeam(team: string): boolean {
    return this.config.earlyShift.inpatientTeams.includes(team);
  }

  toggleEarlyInpatientTeam(team: string): void {
    const arr = this.config.earlyShift.inpatientTeams;
    const idx = arr.indexOf(team);
    if (idx === -1) {
      arr.push(team);
      this.config.earlyShift.inpatientCapacity[team] = 2;
    } else {
      arr.splice(idx, 1);
      delete this.config.earlyShift.inpatientCapacity[team];
    }
    arr.sort();
  }

  // --- Early shift regular team toggles ---
  isEarlyRegularTeam(team: string): boolean {
    return this.config.earlyShift.regularTeams.includes(team);
  }

  toggleEarlyRegularTeam(team: string): void {
    const arr = this.config.earlyShift.regularTeams;
    const idx = arr.indexOf(team);
    if (idx === -1) {
      arr.push(team);
    } else {
      arr.splice(idx, 1);
    }
    arr.sort();
  }

  // --- Late shift inpatient team toggles ---
  isLateInpatientTeam(team: string): boolean {
    return this.config.lateShift.inpatientTeams.includes(team);
  }

  toggleLateInpatientTeam(team: string): void {
    const arr = this.config.lateShift.inpatientTeams;
    const idx = arr.indexOf(team);
    if (idx === -1) {
      arr.push(team);
      this.config.lateShift.inpatientCapacity[team] = 2;
    } else {
      arr.splice(idx, 1);
      delete this.config.lateShift.inpatientCapacity[team];
    }
    arr.sort();
  }

  // --- Late shift regular team toggles ---
  isLateRegularTeam(team: string): boolean {
    return this.config.lateShift.regularTeams.includes(team);
  }

  toggleLateRegularTeam(team: string): void {
    const arr = this.config.lateShift.regularTeams;
    const idx = arr.indexOf(team);
    if (idx === -1) {
      arr.push(team);
    } else {
      arr.splice(idx, 1);
    }
    arr.sort();
  }

  private syncCapacity(shift: 'earlyShift' | 'lateShift'): void {
    const teams = this.config[shift].inpatientTeams;
    const cap = this.config[shift].inpatientCapacity;
    // Remove capacity for teams no longer in list
    for (const key of Object.keys(cap)) {
      if (!teams.includes(key)) delete cap[key];
    }
    // Add default capacity for new teams
    for (const team of teams) {
      if (!(team in cap)) cap[team] = 2;
    }
  }
}

import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ALERT_CAUSES, ALERT_SUGGESTIONS, LAB_ITEM_DISPLAY_NAMES } from '@/constants/labAlertConstants';
import { PatientLabSummaryPanelComponent } from '../../patient-lab-summary-panel/patient-lab-summary-panel.component';
import { LabMedCorrelationViewComponent } from '../../lab-med-correlation-view/lab-med-correlation-view.component';

@Component({
  selector: 'app-lab-alert-detail-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientLabSummaryPanelComponent, LabMedCorrelationViewComponent],
  templateUrl: './lab-alert-detail-modal.component.html',
  styleUrl: './lab-alert-detail-modal.component.css'
})
export class LabAlertDetailModalComponent implements OnChanges {
  @Input() isVisible = true;
  @Input() patient: any = null;
  @Input() abnormalityKey = '';
  @Input() initialAnalysis = '';
  @Input() initialSuggestion = '';
  @Output() close = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<{ analysisText: string; suggestionText: string }>();

  activeTab = 'analysis';
  selectedCauses: string[] = [];
  otherCauseText = '';
  selectedSuggestions: string[] = [];
  otherSuggestionText = '';
  labItemDisplayNames: Record<string, string> = LAB_ITEM_DISPLAY_NAMES;

  get groupedCauses(): Record<string, any[]> {
    const causes = ALERT_CAUSES[this.abnormalityKey] || [];
    return causes.reduce((acc: Record<string, any[]>, cause: any) => {
      (acc[cause.category] = acc[cause.category] || []).push(cause);
      return acc;
    }, {});
  }

  get groupedSuggestions(): Record<string, any[]> {
    const suggestions = ALERT_SUGGESTIONS[this.abnormalityKey] || [];
    return suggestions.reduce((acc: Record<string, any[]>, suggestion: any) => {
      (acc[suggestion.category] = acc[suggestion.category] || []).push(suggestion);
      return acc;
    }, {});
  }

  get groupedCausesEntries(): [string, any[]][] {
    return Object.entries(this.groupedCauses);
  }

  get groupedSuggestionsEntries(): [string, any[]][] {
    return Object.entries(this.groupedSuggestions);
  }

  private parseInitialText(text: string): { selected: string[]; other: string } {
    if (!text) return { selected: [], other: '' };
    const items = text.split('; ').filter(Boolean);
    const predefinedCauses = (ALERT_CAUSES[this.abnormalityKey] || []).map((c: any) => c.text);
    const predefinedSuggestions = (ALERT_SUGGESTIONS[this.abnormalityKey] || []).map((s: any) => s.text);
    const predefined = [...predefinedCauses, ...predefinedSuggestions];

    const selected = items.filter(item => predefined.includes(item));
    const other = items.filter(item => !predefined.includes(item)).join('; ');
    return { selected, other };
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.isVisible) {
      const analysisParsed = this.parseInitialText(this.initialAnalysis);
      this.selectedCauses = analysisParsed.selected;
      this.otherCauseText = analysisParsed.other;

      const suggestionParsed = this.parseInitialText(this.initialSuggestion);
      this.selectedSuggestions = suggestionParsed.selected;
      this.otherSuggestionText = suggestionParsed.other;

      this.activeTab = 'analysis';
    }
  }

  isCauseSelected(causeText: string): boolean {
    return this.selectedCauses.includes(causeText);
  }

  toggleCause(causeText: string): void {
    const index = this.selectedCauses.indexOf(causeText);
    if (index > -1) {
      this.selectedCauses.splice(index, 1);
    } else {
      this.selectedCauses.push(causeText);
    }
  }

  isSuggestionSelected(suggestionText: string): boolean {
    return this.selectedSuggestions.includes(suggestionText);
  }

  toggleSuggestion(suggestionText: string): void {
    const index = this.selectedSuggestions.indexOf(suggestionText);
    if (index > -1) {
      this.selectedSuggestions.splice(index, 1);
    } else {
      this.selectedSuggestions.push(suggestionText);
    }
  }

  handleConfirm(): void {
    const finalAnalysisText = [...this.selectedCauses, this.otherCauseText.trim()]
      .filter(Boolean)
      .join('; ');
    const finalSuggestionText = [...this.selectedSuggestions, this.otherSuggestionText.trim()]
      .filter(Boolean)
      .join('; ');

    this.confirm.emit({
      analysisText: finalAnalysisText,
      suggestionText: finalSuggestionText,
    });
    this.handleClose();
  }

  handleClose(): void {
    this.close.emit();
  }
}

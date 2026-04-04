import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class DateStateService {
  private _selectedDate: string = '';

  get selectedDate(): string {
    return this._selectedDate;
  }

  setDate(date: string): void {
    this._selectedDate = date;
  }

  clear(): void {
    this._selectedDate = '';
  }
}
